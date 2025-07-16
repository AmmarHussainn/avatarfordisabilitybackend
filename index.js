const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const axios = require("axios");
const nodemailer = require("nodemailer");
const fsPromises = require("fs").promises;
const { body, validationResult } = require("express-validator");

const puppeteer = require('puppeteer');
const path = require('path')
const fs = require('fs').promises;
const handlebars = require('handlebars');
const pdf = require('html-pdf');
const { PDFDocument } = require('pdf-lib');
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Mongoose Schemas
const medicalAppointmentSchema = new mongoose.Schema({
  doctorName: { type: String, trim: true },
  officeName: { type: String, trim: true },
  address: { type: String, trim: true },
  medicalConditionsTreated: { type: String, trim: true },
  phone: { type: String, trim: true },
  fax: { type: String, trim: true },
  dateOfLastAppointment: { type: Date },
  dateOfNextAppointment: { type: Date },
  isNewDoctor: { type: Boolean },
  isDoctorSeenPreviously: { type: Boolean },
  isFamilyDoctor: { type: Boolean },
  isSpecialist: { type: Boolean },
  specialistType: { type: String, trim: true },
  testingOrdered: { type: Boolean },
  testingType: { type: String, trim: true },
  testingWhen: { type: Date },
  testingFacility: { type: String, trim: true },
});

const conditionChangesSchema = new mongoose.Schema({
  hasChanges: { type: Boolean, required: true },
  description: { type: String, trim: true },
  whenChanged: { type: Date },
});

const activityLimitationsSchema = new mongoose.Schema({
  hasLimitations: { type: Boolean, required: true },
  examples: { type: String, trim: true },
});

const emergencyContactSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  phone: { type: String, trim: true },
  relationship: { type: String, trim: true },
});

const disabilityAppealSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  ssn: { type: String, required: true, trim: true, match: [/^\d{4}$/] },
  medicalAppointments: { type: [medicalAppointmentSchema], default: [] },
  conditionChanges: { type: conditionChangesSchema, required: true },
  activityLimitations: { type: activityLimitationsSchema, required: true },
  emergencyContact: { type: emergencyContactSchema, required: true },
  timestamp: { type: Date, default: Date.now },
});

const DisabilityAppeal = mongoose.model("DisabilityAppeal", disabilityAppealSchema);

// Validation Middleware
const validateDisabilityAppeal = [
  // Step 1 - Personal Information
  body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters'),
  body('ssn').trim().matches(/^\d{4}$/).withMessage('SSN must be 4 digits'),

  // Step 2 - Medical Appointments
  body('medicalAppointments').isArray(),
  body('medicalAppointments.*.doctorName').optional().trim(),
  body('medicalAppointments.*.officeName').optional().trim(),
  body('medicalAppointments.*.address').optional().trim(),
  body('medicalAppointments.*.medicalConditionsTreated').optional().trim(),
  body('medicalAppointments.*.phone').optional().trim(),
  body('medicalAppointments.*.fax').optional().trim(),
  body('medicalAppointments.*.dateOfLastAppointment').optional().isISO8601(),
  body('medicalAppointments.*.dateOfNextAppointment').optional().isISO8601(),
  body('medicalAppointments.*.isNewDoctor').optional().isBoolean(),
  body('medicalAppointments.*.isDoctorSeenPreviously').optional().isBoolean(),
  body('medicalAppointments.*.isFamilyDoctor').optional().isBoolean(),
  body('medicalAppointments.*.isSpecialist').optional().isBoolean(),
  body('medicalAppointments.*.specialistType').optional().trim(),
  body('medicalAppointments.*.testingOrdered').optional().isBoolean(),
  body('medicalAppointments.*.testingType').optional().trim(),
  body('medicalAppointments.*.testingWhen').optional().isISO8601(),
  body('medicalAppointments.*.testingFacility').optional().trim(),

  // Step 3 - Condition Changes & Activities
  body('conditionChanges.hasChanges').isBoolean(),
  body('conditionChanges.description')
    .if(body('conditionChanges.hasChanges').equals(true))
    .notEmpty()
    .withMessage('Description is required when changes exist'),
  body('conditionChanges.whenChanged')
    .if(body('conditionChanges.hasChanges').equals(true))
    .optional()
    .isISO8601(),

  body('activityLimitations.hasLimitations').isBoolean(),
  body('activityLimitations.examples')
    .if(body('activityLimitations.hasLimitations').equals(true))
    .notEmpty()
    .withMessage('Examples are required when limitations exist'),

  // Emergency Contact
  body('emergencyContact.name').trim().notEmpty(),
  body('emergencyContact.phone').trim().notEmpty(),
  body('emergencyContact.relationship').trim().notEmpty(),
];

async function generateDisabilityAppealPDF(formData) {
  try {
    // Load template
    const templatePath = path.join(__dirname, 'disability-appeal-template.html');
    const htmlTemplate = await fs.readFile(templatePath, 'utf8');

    // Convert Mongoose document to plain object
    const plainData = formData.toObject ? formData.toObject() : formData;
    
    // Prepare template data
    const templateData = {
      name: plainData.name,
      ssn: plainData.ssn,
      medicalAppointments: plainData.medicalAppointments || [],
      conditionChanges: plainData.conditionChanges || {},
      activityLimitations: plainData.activityLimitations || {},
      emergencyContact: plainData.emergencyContact || {}
    };

    // Register Handlebars helpers
    handlebars.registerHelper('formatDate', function(date) {
      if (!date) return 'N/A';
      return new Date(date).toLocaleDateString();
    });

    handlebars.registerHelper('boolToYesNo', function(value) {
      return value ? 'Yes' : 'No';
    });

    handlebars.registerHelper('gt', function(a, b) {
      return a > b;
    });

    // Compile template
    const template = handlebars.compile(htmlTemplate);
    const html = template(templateData);

    // Debug: Save HTML for inspection
    await fs.writeFile('debug_disability_appeal.html', html);

    // PDF generation options (matches your A4 requirements)
    const pdfOptions = {
      format: 'A4',
      orientation: 'portrait',
     
      type: 'pdf',
      quality: '100',
      timeout: 60000
    };

    // Generate PDF
    const pdfFileName = `Disability_Appeal_${Date.now()}.pdf`;
    
    return new Promise((resolve, reject) => {
      pdf.create(html, pdfOptions).toFile(pdfFileName, (err, res) => {
        if (err) {
          console.error('PDF generation failed:', err);
          return reject(err);
        }
        console.log('PDF generated successfully:', res.filename);
        resolve(pdfFileName);
      });
    });

  } catch (error) {
    console.error('PDF generation failed:', error);
    throw error;
  }
}

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// API Endpoint to Handle Disability Appeal Form Submission
app.post("/api/disability-appeal", validateDisabilityAppeal, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  try {
    // Save to MongoDB
    const savedAppeal = await DisabilityAppeal.create(req.body);

    // Generate PDF
    let pdfFileName;
    try {
      pdfFileName = await generateDisabilityAppealPDF(savedAppeal);

      // Send email with PDF attachment
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: ["ammar@meetgabbi.com", "ayaz.ext@gmail.com"],
        subject: `Disability Appeal Form Submission - ${savedAppeal.name}`,
        text: `Dear Team,\n\nA new disability appeal form has been submitted by ${savedAppeal.name}. Please find attached the PDF containing the submitted information.\n\nBest regards,\nSystem`,
        attachments: [{ 
          filename: `disability_appeal_${savedAppeal._id}.pdf`, 
          path: pdfFileName 
        }],
      };

      await transporter.sendMail(mailOptions);
      console.log("Email sent successfully");

      // Clean up PDF file
      await fsPromises.unlink(pdfFileName);
    } catch (pdfError) {
      console.error("Error generating PDF or sending email:", pdfError);
    }

    // Send data to GoHighLevel webhook
    try {
      const webhookUrl = "https://services.leadconnectorhq.com/hooks/CECLKLJ2HKEDjXUL5Ibj/webhook-trigger/280d88e9-2564-423c-9ac6-9976ec6b7c60";
      await axios.post(webhookUrl, {
        name: savedAppeal.name,
        ssn: savedAppeal.ssn,
        medicalAppointments: savedAppeal.medicalAppointments,
        conditionChanges: savedAppeal.conditionChanges,
        activityLimitations: savedAppeal.activityLimitations,
        emergencyContact: savedAppeal.emergencyContact,
        timestamp: savedAppeal.timestamp,
      });
      console.log("Data successfully sent to GoHighLevel webhook");
    } catch (webhookError) {
      console.error("Error sending data to GoHighLevel webhook:", webhookError);
    }

    res.status(201).json({ 
      message: "Disability appeal submitted successfully", 
      data: savedAppeal 
    });
  } catch (error) {
    console.error("Error saving disability appeal:", error);
    res.status(500).json({
      error: error.message || "Internal server error",
      details: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

app.get("/api/test", (req, res) => {
  res.json({ message: "API is working correctly 🚀" });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});