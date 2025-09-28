const express = 
require('express');
const nodemailer = 
require('nodemailer');
const bodyParser = 
require('body-parser');
const cors = require('cors');

const app = express();

// allow your domains
app.use(cors({
  origin: 
['https://1stanswerbot.com','https://www.1stanswerbot.com']
}));
app.use(bodyParser.json());

// health check
app.get('/health', (req, res) 
=> res.send('Server is 
running!'));

// escalate endpoint
app.post('/escalate', async 
(req, res) => {
  const { question, userEmail } 
= req.body || {};
  if (!question) return 
res.status(400).json({ status: 
'error', message: 'Missing 
question' });

  try {
    const transporter = 
nodemailer.createTransport({
      service: 'Gmail',
      auth: { user: 
process.env.EMAIL_USER, pass: 
process.env.EMAIL_PASS }
    });

    await 
transporter.sendMail({
      from: `"1st Answer Bot" 
<${process.env.EMAIL_USER}>`,
      to: 
process.env.ADMIN_EMAIL,
      subject: 'Unanswered Bot 
Question',
      text: `Question: 
${question}\nUser: ${userEmail 
|| 'unknown'}`
    });

    res.json({ status: 'ok', 
message: 'Question escalated' 
});
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
status: 'error', message: 
'Failed to send email' });
  }
});

const PORT = process.env.PORT 
|| 3000;
app.listen(PORT, () => 
console.log(`Server running on 
port ${PORT}`));{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11120\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 const express = require('express');\
const nodemailer = require('nodemailer');\
const bodyParser = require('body-parser');\
const cors = require('cors');\
\
const app = express();\
\
// Allow only your site domains to call this API\
app.use(cors(\{\
  origin: ['https://1stanswerbot.com','https://www.1stanswerbot.com']\
\}));\
\
app.use(bodyParser.json());\
\
// Escalation endpoint\
app.post('/escalate', async (req, res) => \{\
  const \{ question, userEmail \} = req.body;\
\
  try \{\
    // Configure Gmail transporter\
    let transporter = nodemailer.createTransport(\{\
      service: 'Gmail',\
      auth: \{\
        user: process.env.EMAIL_USER,\
        pass: process.env.EMAIL_PASS\
      \}\
    \});\
\
    // Send the email\
    await transporter.sendMail(\{\
      from: `"1st Answer Bot" <$\{process.env.EMAIL_USER\}>`,\
      to: process.env.ADMIN_EMAIL,\
      subject: "Unanswered Bot Question",\
      text: `Question: $\{question\}\\nUser: $\{userEmail || "unknown"\}`\
    \});\
\
    res.json(\{ status: 'ok', message: 'Question escalated' \});\
  \} catch (err) \{\
    console.error(err);\
    res.status(500).json(\{ status: 'error', message: 'Failed to send email' \});\
  \}\
\});\
\
// Start server\
const PORT = process.env.PORT || 3000;\
app.listen(PORT, () => console.log(`Server running on port $\{PORT\}`));\
// Health check endpoint\
app.get("/health", (req, res) => \{\
  res.send("Server is running!");\
\});}
