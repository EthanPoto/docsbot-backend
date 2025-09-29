// server.js
const express = require('express');
const app = express();

// Use Render's PORT or fallback to 3000 for local dev
const PORT = process.env.PORT || 3000;

// Simple health check route
app.get('/healthz', (req, res) => {
  res.send('ok');
});

// Example root route
app.get('/', (req, res) => {
  res.send('Hello from Docsbot Backend');
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
