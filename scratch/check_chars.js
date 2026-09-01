require('dotenv').config();
const config = require('../config/settings');
console.log('CONFIG GROUP NAME:', JSON.stringify(config.whatsapp.groupName));
if (config.whatsapp.groupName) {
  console.log('Length:', config.whatsapp.groupName.length);
  console.log('Char codes:', [...config.whatsapp.groupName].map(c => c.charCodeAt(0)));
}
