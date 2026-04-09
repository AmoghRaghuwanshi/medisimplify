const serverless = require("serverless-http");
const app = require("../../server");

module.exports.handler = serverless(app, { basePath: '/.netlify/functions/api' });
