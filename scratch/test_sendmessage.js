require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config/settings');

async function testSendMessage() {
  console.log('--- TEST SAFE GROUP DISCOVERY & MESSAGE SENDING ---');
  console.log('Target Group Name:', config.whatsapp.groupName);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('ready', async () => {
    console.log('WhatsApp READY!');

    // Step 1: Find target group safely via in-page Store without calling getChats()
    console.log('\nExecuting safe in-page group lookup...');
    const groupInfo = await client.pupPage.evaluate((targetName) => {
      const chats = window.Store.Chat.getModelsArray();
      const found = chats.find(c => 
        (c.name === targetName || c.formattedTitle === targetName) && 
        (c.isGroup || c.id?._serialized?.endsWith('@g.us'))
      );
      return found ? { id: found.id._serialized, name: found.name || found.formattedTitle } : null;
    }, config.whatsapp.groupName);

    console.log('Group Lookup Result:', groupInfo);

    if (!groupInfo) {
      console.error('FAILED: Group not found in Store models!');
      process.exit(1);
    }

    console.log(`\nFound group "${groupInfo.name}" with ID: ${groupInfo.id}`);

    // Step 2: Test sending a test message directly using the group ID
    console.log('\nSending test message to group...');
    try {
      const testMsg = `🚗 *SYSTEM DIAGNOSTIC TEST*\n\nWhatsApp group discovery successfully verified! ✅\nTime: ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })}`;
      const res = await client.sendMessage(groupInfo.id, testMsg);
      console.log('SUCCESS! Message sent via client.sendMessage(groupInfo.id, text)');
      console.log('Message ID:', res.id._serialized);
    } catch (err) {
      console.error('sendMessage FAILED:', err);
    }

    process.exit(0);
  });

  await client.initialize();
}

testSendMessage().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
