const serverless = require('serverless-http');
const app = require('../../server.js');   // points to your main server.js

module.exports.handler = serverless(app);