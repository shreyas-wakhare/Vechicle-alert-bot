const { Client, LocalAuth } = require('whatsapp-web.js');
const config = require('../config/settings');

async function testWhatsApp() {
  console.log('--- DIAGNOSTIC CHAT DISCOVERY TEST ---');
  console.log('Target Group Name:', config.whatsapp.groupName);

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.whatsapp.sessionPath }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
  });

  client.on('qr', () => console.log('QR Code requested - session may be invalid'));
  client.on('authenticated', () => console.log('WhatsApp authenticated'));
  client.on('auth_failure', (m) => console.error('Auth failure:', m));

  client.on('ready', async () => {
    console.log('WhatsApp READY event fired!');

    // Test 1: Try getChats() directly and log detailed error
    console.log('\n--- TEST 1: client.getChats() ---');
    try {
      const chats = await client.getChats();
      console.log(`Success! Total chats returned: ${chats.length}`);
      chats.forEach(c => {
        console.log(`- [${c.isGroup ? 'GROUP' : 'USER'}] "${c.name}" (ID: ${c.id._serialized})`);
      });
      const target = chats.find(c => c.isGroup && c.name === config.whatsapp.groupName);
      if (target) {
        console.log(`SUCCESS: Found target group "${target.name}" with ID: ${target.id._serialized}`);
      } else {
        console.log(`WARNING: Target group "${config.whatsapp.groupName}" not found in ${chats.length} chats.`);
      }
    } catch (err) {
      console.error('getChats() FAILED!');
      console.error('Error:', err);
      console.error('Stack:', err?.stack);
    }

    // Test 2: Inspect Store object inside browser
    console.log('\n--- TEST 2: Inspect window.Store inside page ---');
    try {
      const storeDetails = await client.pupPage.evaluate(async () => {
        const info = {};
        info.hasStore = !!window.Store;
        info.hasChat = !!window.Store?.Chat;
        info.chatModelsLength = window.Store?.Chat?.getModelsArray()?.length;

        // Test individual chat model serialization
        if (window.Store?.Chat) {
          const chatModels = window.Store.Chat.getModelsArray();
          info.chatSummaries = [];
          for (let i = 0; i < chatModels.length; i++) {
            const chat = chatModels[i];
            const summary = { index: i, id: chat.id?._serialized, isGroup: !!chat.isGroup, name: chat.name || chat.formattedTitle };
            try {
              // Try WWebJS.getChatModel(chat)
              await window.WWebJS.getChatModel(chat);
              summary.status = 'OK';
            } catch (e) {
              summary.status = 'ERROR';
              summary.error = e ? (e.stack || e.message || String(e)) : 'Unknown error';
            }
            info.chatSummaries.push(summary);
          }
        }
        return info;
      });
      console.log('Browser Store inspection:', JSON.stringify(storeDetails, null, 2));
    } catch (err) {
      console.error('Browser Store inspection failed:', err);
    }

    // Test 3: Test alternative group discovery methods (e.g. getChatById or Store queries)
    console.log('\n--- TEST 3: Alternative Group Search ---');
    try {
      const groupSearch = await client.pupPage.evaluate(async (targetName) => {
        const chats = window.Store.Chat.getModelsArray();
        const matches = [];
        for (const chat of chats) {
          const name = chat.name || chat.formattedTitle;
          const isGroup = chat.isGroup || chat.id?._serialized?.endsWith('@g.us');
          if (isGroup) {
            matches.push({
              id: chat.id?._serialized,
              name: name,
              isGroup: true,
              matchesTarget: name === targetName
            });
          }
        }
        return matches;
      }, config.whatsapp.groupName);
      console.log('Raw Store Group Search:', JSON.stringify(groupSearch, null, 2));
    } catch (err) {
      console.error('Alternative search failed:', err);
    }

    process.exit(0);
  });

  await client.initialize();
}

testWhatsApp().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
