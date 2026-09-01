require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config/settings');

async function testGetChatById() {
  console.log('--- TEST GET CHAT BY ID ---');
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('ready', async () => {
    console.log('WhatsApp READY');

    // Method 1: getChatById using known ID or searched ID
    try {
      const chatId = "120363407488787944@g.us";
      console.log(`Testing client.getChatById('${chatId}')...`);
      const chat = await client.getChatById(chatId);
      console.log('SUCCESS! Chat found via getChatById:');
      console.log(`Name: "${chat.name}", ID: ${chat.id._serialized}, isGroup: ${chat.isGroup}`);
    } catch (err) {
      console.error('getChatById failed:', err);
    }

    // Method 2: Safe chat search using Store.Chat in page
    try {
      console.log(`\nTesting safe group lookup by name: "${config.whatsapp.groupName}"...`);
      const targetChatId = await client.pupPage.evaluate((targetName) => {
        const chats = window.Store.Chat.getModelsArray();
        const found = chats.find(c => (c.name === targetName || c.formattedTitle === targetName) && (c.isGroup || c.id?._serialized?.endsWith('@g.us')));
        return found ? found.id._serialized : null;
      }, config.whatsapp.groupName);

      console.log('Safe search returned chat ID:', targetChatId);

      if (targetChatId) {
        const chat = await client.getChatById(targetChatId);
        console.log(`Resolved chat object via safe search: "${chat.name}" (${chat.id._serialized})`);
      }
    } catch (err) {
      console.error('Safe search failed:', err);
    }

    process.exit(0);
  });

  await client.initialize();
}

testGetChatById().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
