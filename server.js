// server.js
const express = require('express');
const app = express();

// Use Render's PORT or default 3000 for local dev
const PORT = process.env.PORT || 3000;

// Health check route for Render
app.get('/healthz', (req, res) => {
  res.send('ok');
});

// Root route
app.get('/', (req, res) => {
  res.send('Hello from Docsbot Backend');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
