// Mengimpor semua komponen yang dibutuhkan 
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags, EmbedBuilder } = require('discord.js'); 
const { fetch } = require('undici'); 
const { Client: NotionClient } = require('@notionhq/client'); 
require('dotenv').config(); 

// Inisialisasi 
const client = new Client({ intents: [GatewayIntentBits.Guilds] }); 
const notion = new NotionClient({ auth: process.env.NOTION_KEY }); 

// Variabel untuk menyimpan sesi sementara 
const deploymentSessions = new Map(); 
const pendingSaves = new Map(); 


// --- FUNGSI BANTUAN --- 
function splitTextIntoChunks(text, chunkSize = 2000) { 
    const chunks = []; 
    for (let i = 0; i < text.length; i += chunkSize) { 
        chunks.push(text.substring(i, i + chunkSize)); 
    } 
    return chunks; 
} 

async function triggerN8nWebhook(payload) { 
    try { 
        const response = await fetch(process.env.N8N_WEBHOOK_URL, { 
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            body: JSON.stringify(payload), 
        }); 
        return response.ok; 
    } catch (error) { 
        console.error('Error sending to n8n:', error); 
        return false; 
    } 
} 

// --- CLIENT EVENTS --- 
client.once(Events.ClientReady, () => { 
    console.log(`Logged in as ${client.user.tag}`); 
});

// ====================================================================
// --- PENANGANAN ERROR GLOBAL UNTUK MENCEGAH CRASH ---
// ====================================================================
process.on('unhandledRejection', error => {
    console.error('Unhandled promise rejection:', error);
});
process.on('uncaughtException', error => {
    console.error('Uncaught exception:', error);
});
client.on('error', error => {
    console.error('A websocket connection encountered an error:', error);
});


// ==================================================================== 
// --- MAIN INTERACTION HANDLER --- 
// ==================================================================== 
client.on(Events.InteractionCreate, async interaction => { 
    try {
        // ================== SLASH COMMANDS ================== 
        if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') { 
            const initialRow = new ActionRowBuilder().addComponents( 
                new ButtonBuilder().setCustomId('add_server_start').setLabel('Tambah Server Baru').setStyle(ButtonStyle.Success).setEmoji('➕'), 
                new ButtonBuilder().setCustomId('run_deploy_start').setLabel('Jalankan Deploy').setStyle(ButtonStyle.Primary).setEmoji('🚀'), 
                new ButtonBuilder().setCustomId('view_servers_start').setLabel('Lihat Server').setStyle(ButtonStyle.Secondary).setEmoji('👀') 
            ); 
            await interaction.reply({ content: 'Pilih tindakan yang ingin Anda lakukan:', components: [initialRow], flags: [MessageFlags.Ephemeral] }); // PERBAIKAN: ephemeral -> flags
            return;
        } 

        // ================== MODAL SUBMISSIONS ================== 
        if (interaction.isModalSubmit()) { 
            const modalIdParts = interaction.customId.split(':'); 
            const modalType = modalIdParts[0]; 
            const contextId = modalIdParts[1]; 

            if (modalType === 'add_server_modal') { 
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); // PERBAIKAN: ephemeral -> flags
                const name = interaction.fields.getTextInputValue('serverName'); 
                const ip = interaction.fields.getTextInputValue('serverIp'); 
                const username = interaction.fields.getTextInputValue('serverUser'); 
                const privateKey = interaction.fields.getTextInputValue('serverKey'); 
                const serverData = { name, ip, username, privateKey }; 
                pendingSaves.set(interaction.id, serverData); 
                const response = await notion.search({ filter: { value: 'database', property: 'object' } }); 
                if (response.results.length === 0) throw new Error('Bot tidak memiliki akses ke database manapun.'); 
                const dbOptions = response.results.map(db => ({ 
                    label: (db.title[0]?.plain_text || 'Database tanpa nama').substring(0, 100), 
                    description: `ID: ${db.id}`.substring(0, 100), 
                    value: db.id, 
                })); 
                const selectDbMenu = new StringSelectMenuBuilder() 
                    .setCustomId(`save_to_db:${interaction.id}`) 
                    .setPlaceholder('Pilih database tujuan untuk menyimpan server') 
                    .addOptions(dbOptions.slice(0, 25)); 
                await interaction.editReply({ content: `Server **${name}** siap disimpan. Silakan pilih database tujuan:`, components: [new ActionRowBuilder().addComponents(selectDbMenu)] }); 
            
            } else if (modalType === 'multi_deploy_add_modal') { 
                await interaction.deferUpdate(); 
                const messageId = contextId; 
                const session = deploymentSessions.get(messageId); 
                if (!session) return interaction.followUp({ content: '❌ Sesi multi-deploy ini sudah tidak aktif.', flags: [MessageFlags.Ephemeral] }); 
                const name = interaction.fields.getTextInputValue('serverName'); 
                const keyChunks = splitTextIntoChunks(interaction.fields.getTextInputValue('serverKey')); 
                const richTextChunks = keyChunks.map(chunk => ({ type: 'text', text: { content: chunk } })); 
                const newPage = await notion.pages.create({ 
                    parent: { database_id: session.databaseId }, 
                    properties: { 
                        Name: { title: [{ text: { content: name } }] }, 
                        IP: { rich_text: [{ text: { content: interaction.fields.getTextInputValue('serverIp') } }] }, 
                        Username: { rich_text: [{ text: { content: interaction.fields.getTextInputValue('serverUser') } }] }, 
                    }, 
                    children: [{ object: 'block', type: 'code', code: { rich_text: richTextChunks, language: 'shell' } }], 
                }); 
                session.newlyAdded.add(newPage.id); 
                const response = await notion.databases.query({ database_id: session.databaseId }); 
                const serverOptions = response.results.map(page => ({ 
                    label: page.properties.Name.title[0].plain_text, 
                    description: `IP: ${page.properties.IP.rich_text.length > 0 ? page.properties.IP.rich_text[0].plain_text : 'Tidak ada IP'}`, 
                    value: page.id, 
                })); 
                const multiSelectMenu = new StringSelectMenuBuilder() 
                    .setCustomId(`multi_deploy_selection:${messageId}`) 
                    .setPlaceholder('Pilih server yang sudah ada') 
                    .setMinValues(0).setMaxValues(Math.max(1, serverOptions.length)) 
                    .addOptions(serverOptions.length > 0 ? serverOptions : [{ label: 'Tidak ada server', value: 'no_server' }]); 
                const actionRow = new ActionRowBuilder().addComponents( 
                    new ButtonBuilder().setCustomId(`multi_deploy_add_new:${messageId}`).setLabel('Tambah Server Baru').setStyle(ButtonStyle.Success).setEmoji('➕'), 
                    new ButtonBuilder().setCustomId(`multi_deploy_execute:${messageId}`).setLabel('Jalankan Deploy').setStyle(ButtonStyle.Primary).setEmoji('🚀') 
                ); 
                const originalMessage = await interaction.channel.messages.fetch(messageId); 
                await originalMessage.edit({ 
                    content: `✅ Server "${name}" berhasil ditambahkan! Daftar di bawah sudah diperbarui.`, 
                    components: [new ActionRowBuilder().addComponents(multiSelectMenu), actionRow] 
                }); 
            } 
            return; 
        } 

        // ================== BUTTON CLICKS ================== 
        if (interaction.isButton()) { 
            const customIdParts = interaction.customId.split(':'); 
            const customId = customIdParts[0]; 
            const contextId = customIdParts[1] || interaction.message.id; 

            // PERBAIKAN: deferUpdate() dipindahkan ke dalam setiap blok if yang membutuhkannya.
            
            if (customId === 'add_server_start') { 
                // Aksi ini hanya memunculkan modal, JANGAN defer.
                const modal = new ModalBuilder().setCustomId('add_server_modal').setTitle('Tambah Konfigurasi Server Baru'); 
                const nameInput = new TextInputBuilder().setCustomId('serverName').setLabel("Nama Server").setStyle(TextInputStyle.Short).setRequired(true); 
                const ipInput = new TextInputBuilder().setCustomId('serverIp').setLabel("IP Address Server").setStyle(TextInputStyle.Short).setRequired(true); 
                const userInput = new TextInputBuilder().setCustomId('serverUser').setLabel("Username SSH").setStyle(TextInputStyle.Short).setRequired(true); 
                const keyInput = new TextInputBuilder().setCustomId('serverKey').setLabel("Private Key SSH").setStyle(TextInputStyle.Paragraph).setRequired(true); 
                modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(userInput), new ActionRowBuilder().addComponents(keyInput)); 
                await interaction.showModal(modal); 

            } else if (customId === 'run_deploy_start') { 
                await interaction.deferUpdate(); // Defer karena akan mengedit pesan
                const deployModeRow = new ActionRowBuilder().addComponents( 
                    new ButtonBuilder().setCustomId('single_deploy_init').setLabel('Single Deploy').setStyle(ButtonStyle.Secondary).setEmoji('▶️'), 
                    new ButtonBuilder().setCustomId('multi_deploy_init').setLabel('Multi Deploy').setStyle(ButtonStyle.Success).setEmoji('🚀'), 
                ); 
                await interaction.editReply({ content: 'Pilih mode deploy:', components: [deployModeRow] }); 

            } else if (customId === 'view_servers_start' || customId === 'single_deploy_init' || customId === 'multi_deploy_init') { 
                await interaction.deferUpdate(); // Defer karena akan ada panggilan API Notion
                const searchResponse = await notion.search({ filter: { value: 'database', property: 'object' } }); 
                if (searchResponse.results.length === 0) return interaction.editReply({ content: '❌ Bot tidak memiliki akses ke database manapun.', components: [] }); 
                let actionType; 
                if(customId === 'view_servers_start') actionType = 'view'; 
                else if(customId === 'single_deploy_init') actionType = 'single_run'; 
                else if(customId === 'multi_deploy_init') actionType = 'multi_run'; 
                const dbOptions = searchResponse.results.map(db => ({ 
                    label: (db.title[0]?.plain_text || 'Database tanpa nama').substring(0, 100), 
                    description: `ID: ${db.id}`.substring(0, 100), 
                    value: `${db.id}|${actionType}`, 
                })); 
                const selectDbMenu = new StringSelectMenuBuilder() 
                    .setCustomId('select_db') 
                    .setPlaceholder('Pilih database yang akan digunakan') 
                    .addOptions(dbOptions.slice(0, 25)); 
                await interaction.editReply({ content: 'Langkah 1: Pilih database yang akan digunakan.', components: [new ActionRowBuilder().addComponents(selectDbMenu)] }); 
            
            } else if (customId === 'multi_deploy_add_new') {
                // Aksi ini hanya memunculkan modal, JANGAN defer.
                const modal = new ModalBuilder().setCustomId(`multi_deploy_add_modal:${contextId}`).setTitle('Tambah Server ke Sesi Deploy'); 
                const nameInput = new TextInputBuilder().setCustomId('serverName').setLabel("Nama Server").setStyle(TextInputStyle.Short).setRequired(true); 
                const ipInput = new TextInputBuilder().setCustomId('serverIp').setLabel("IP Address Server").setStyle(TextInputStyle.Short).setRequired(true); 
                const userInput = new TextInputBuilder().setCustomId('serverUser').setLabel("Username SSH").setStyle(TextInputStyle.Short).setRequired(true); 
                const keyInput = new TextInputBuilder().setCustomId('serverKey').setLabel("Private Key SSH").setStyle(TextInputStyle.Paragraph).setRequired(true); 
                modal.addComponents(new ActionRowBuilder().addComponents(nameInput), new ActionRowBuilder().addComponents(ipInput), new ActionRowBuilder().addComponents(userInput), new ActionRowBuilder().addComponents(keyInput)); 
                await interaction.showModal(modal);

            } else if (customId === 'multi_deploy_execute') { 
                await interaction.deferUpdate(); // Defer karena akan ada panggilan API Notion
                await interaction.editReply({ content: 'Menggabungkan semua server dan memulai proses...', components: [] }); 
                const session = deploymentSessions.get(contextId); 
                if (!session) return interaction.followUp({ content: '❌ Sesi deploy tidak ditemukan atau sudah berakhir.', flags: [MessageFlags.Ephemeral] }); 
                const combinedIds = new Set([...session.newlyAdded, ...session.selectedFromMenu]); 
                if (combinedIds.size === 0) { 
                    deploymentSessions.delete(contextId); 
                    return interaction.followUp({ content: '❌ Tidak ada server yang dipilih atau ditambahkan. Proses dibatalkan.', flags: [MessageFlags.Ephemeral] }); 
                } 
                const serverDetailsPromises = Array.from(combinedIds).map(async (pageId) => { 
                    const page = await notion.pages.retrieve({ page_id: pageId }); 
                    const blocksResponse = await notion.blocks.children.list({ block_id: pageId }); 
                    const codeBlock = blocksResponse.results.find(block => block.type === 'code'); 
                    if (!codeBlock) throw new Error(`Kunci privat tidak ditemukan untuk server ${page.properties.Name.title[0].plain_text}`); 
                    return { pageId: page.id, ip: page.properties.IP.rich_text[0].plain_text, username: page.properties.Username.rich_text[0].plain_text, privateKey: codeBlock.code.rich_text.map(rt => rt.plain_text).join('') }; 
                }); 
                const servers = await Promise.all(serverDetailsPromises);
                const payload = { action: 'multi_deploy', servers: servers, requestedBy: interaction.user.tag }; 
                const success = await triggerN8nWebhook(payload); 
                if (success) { 
                    await interaction.followUp({ content: `🚀 Tugas multi-deploy untuk ${servers.length} server berhasil dikirim ke n8n!`, flags: [MessageFlags.Ephemeral] }); 
                } else { 
                    await interaction.followUp({ content: `❌ Gagal mengirim batch tugas ke n8n.`, flags: [MessageFlags.Ephemeral] }); 
                } 
                deploymentSessions.delete(contextId); 
            } 
            return;
        } 

        // ================== SELECT MENUS ================== 
        if (interaction.isStringSelectMenu()) { 
            const customIdParts = interaction.customId.split(':'); 
            const customId = customIdParts[0]; 
            const contextId = customIdParts[1]; 

            if (customId === 'save_to_db') { 
                await interaction.deferUpdate();
                const originalModalId = contextId; 
                const serverData = pendingSaves.get(originalModalId); 
                const selectedDbId = interaction.values[0]; 
                if (!serverData) return interaction.editReply({ content: '❌ Sesi penyimpanan tidak ditemukan.', components: [] }); 
                const keyChunks = splitTextIntoChunks(serverData.privateKey); 
                const richTextChunks = keyChunks.map(chunk => ({ type: 'text', text: { content: chunk } })); 
                await notion.pages.create({ 
                    parent: { database_id: selectedDbId }, 
                    properties: { Name: { title: [{ text: { content: serverData.name } }] }, IP: { rich_text: [{ text: { content: serverData.ip } }] }, Username: { rich_text: [{ text: { content: serverData.username } }] } }, 
                    children: [{ object: 'block', type: 'code', code: { rich_text: richTextChunks, language: 'shell' } }], 
                }); 
                await interaction.editReply({ content: `✅ Server **${serverData.name}** berhasil disimpan di database pilihan Anda!`, components: [] }); 
                pendingSaves.delete(originalModalId); 

            } else if (customId === 'select_db') { 
                await interaction.deferUpdate(); 
                const [selectedDbId, actionType] = interaction.values[0].split('|'); 
                const response = await notion.databases.query({ database_id: selectedDbId }); 
                const allServers = response.results; 
                const serverOptions = allServers.map(page => ({ 
                    label: page.properties.Name.title[0].plain_text, 
                    description: `IP: ${page.properties.IP.rich_text.length > 0 ? page.properties.IP.rich_text[0].plain_text : 'N/A'}`, 
                    value: page.id, 
                })); 
                if (actionType === 'view') { 
                    if (allServers.length === 0) return interaction.editReply({ content: '❌ Database ini kosong.', components: [] });
                    const embed = new EmbedBuilder().setTitle(`Daftar Server`).setColor(0x00AE86).setDescription('Berikut adalah server yang terdaftar. Pilih salah satu di bawah untuk memulai update Docker.').setTimestamp();
                    allServers.slice(0, 25).forEach(p => { 
                        const server = {
                            name: p.properties.Name?.title[0]?.plain_text || 'N/A',
                            ip: p.properties.IP?.rich_text[0]?.plain_text || 'N/A',
                            status: p.properties.Status?.status?.name || 'N/A',
                            version: p.properties['Docker Version']?.rich_text[0]?.plain_text || 'N/A',
                        };
                        embed.addFields({ name: `• ${server.name}`, value: `**IP:** ${server.ip}\n**Status:** ${server.status}\n**Versi:** ${server.version}`, inline: false });
                    });
                    const updateSelectMenu = new StringSelectMenuBuilder().setCustomId('select_server_for_update').setPlaceholder('Pilih server untuk di-update Docker-nya').addOptions(serverOptions.slice(0, 25));
                    const actionRow = new ActionRowBuilder().addComponents(updateSelectMenu);
                    await interaction.editReply({ content: `Menampilkan ${allServers.length} server.`, embeds: [embed], components: [actionRow] });

                } else if (actionType === 'single_run') { 
                    if (serverOptions.length === 0) return interaction.editReply({ content: `❌ Tidak ada server di database ini untuk dijalankan.`, components: [] }); 
                    const selectMenu = new StringSelectMenuBuilder().setCustomId(`execute_single_deploy`).setPlaceholder('Pilih satu server untuk deploy').addOptions(serverOptions.slice(0, 25)); 
                    await interaction.editReply({ content: 'Langkah 2: Silakan pilih server:', components: [new ActionRowBuilder().addComponents(selectMenu)] }); 

                } else if (actionType === 'multi_run') { 
                    if (serverOptions.length === 0) return interaction.editReply({ content: `❌ Tidak ada server di database ini untuk dijalankan.`, components: [] }); 
                    const message = await interaction.editReply({ content: 'Memuat sesi multi-deploy...', components: [] }); 
                    deploymentSessions.set(message.id, { databaseId: selectedDbId, newlyAdded: new Set(), selectedFromMenu: new Set() }); 
                    const multiSelectMenu = new StringSelectMenuBuilder().setCustomId(`multi_deploy_selection:${message.id}`).setPlaceholder('Pilih server yang sudah ada').setMinValues(0).setMaxValues(Math.max(1, serverOptions.length)).addOptions(serverOptions.length > 0 ? serverOptions : [{ label: 'Tidak ada server', value: 'no_server' }]); 
                    const actionRow = new ActionRowBuilder().addComponents( 
                        new ButtonBuilder().setCustomId(`multi_deploy_add_new:${message.id}`).setLabel('Tambah Server Baru').setStyle(ButtonStyle.Success).setEmoji('➕'), 
                        new ButtonBuilder().setCustomId(`multi_deploy_execute:${message.id}`).setLabel('Jalankan Deploy').setStyle(ButtonStyle.Primary).setEmoji('🚀') 
                    ); 
                    await message.edit({ content: `Langkah 2: Sesi Multi-Deploy. Pilih atau tambah server, lalu Jalankan Deploy.`, components: [new ActionRowBuilder().addComponents(multiSelectMenu), actionRow] }); 
                } 

            } else if (customId.startsWith('multi_deploy_selection')) { 
                await interaction.deferUpdate();
                const messageId = contextId; 
                const session = deploymentSessions.get(messageId); 
                if (session) { 
                    session.selectedFromMenu = new Set(interaction.values); 
                    await interaction.followUp({ content: `✅ ${interaction.values.length} server dari menu telah ditambahkan ke sesi.`, flags: [MessageFlags.Ephemeral] }); 
                } 

            } else if (customId === 'select_server_for_update') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pageId = interaction.values[0];
                const page = await notion.pages.retrieve({ page_id: pageId });
                const name = page.properties.Name.title[0].plain_text;
                await interaction.editReply(`⚙️ Anda memilih **${name}**. Mengambil detail dan mengirimkan tugas update Docker...`);
                const ip = page.properties.IP.rich_text[0].plain_text;
                const username = page.properties.Username.rich_text[0].plain_text;
                const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
                const codeBlock = blocksResponse.results.find(block => block.type === 'code');
                if (!codeBlock) return interaction.editReply(`❌ Tidak dapat menemukan Private Key untuk server ${name}.`);
                const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join('');
                const payload = { action: 'update_docker', servers: [{ pageId, ip, username, privateKey }], requestedBy: interaction.user.tag };
                const success = await triggerN8nWebhook(payload);
                if (success) {
                    await interaction.followUp({ content: `✅ Tugas update Docker untuk server **${name}** berhasil dikirim ke n8n!`, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: `⚠️ Gagal mengirim tugas update Docker untuk server **${name}** ke n8n.`, flags: [MessageFlags.Ephemeral] });
                }

            } else if (customId === 'execute_single_deploy') { 
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }); 
                const pageId = interaction.values[0]; 
                const page = await notion.pages.retrieve({ page_id: pageId }); 
                const name = page.properties.Name.title[0].plain_text; 
                const ip = page.properties.IP.rich_text[0].plain_text; 
                const username = page.properties.Username.rich_text[0].plain_text; 
                const blocksResponse = await notion.blocks.children.list({ block_id: pageId }); 
                const codeBlock = blocksResponse.results.find(block => block.type === 'code'); 
                if (!codeBlock) return interaction.editReply('❌ Tidak dapat menemukan Private Key.'); 
                const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join(''); 
                await interaction.editReply(`✅ Anda memilih server "${name}". Mengirim tugas ke n8n...`); 
                const payload = { action: 'single_deploy', servers: [{ pageId: pageId, ip, username, privateKey }], requestedBy: interaction.user.tag }; 
                const success = await triggerN8nWebhook(payload); 
                if (success) { 
                    await interaction.followUp({ content: `🚀 Data untuk server ${name} berhasil dikirim.`, flags: [MessageFlags.Ephemeral] }); 
                } else { 
                    await interaction.followUp({ content: `⚠️ Gagal mengirim data untuk server ${name}.`, flags: [MessageFlags.Ephemeral] }); 
                } 
            } 
        }
    } catch (error) {
        console.error(`Error handling interaction (ID: ${interaction.id}, CustomID: ${interaction.customId || 'N/A'}):`, error);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: '❌ Terjadi kesalahan saat memproses permintaan Anda.', flags: [MessageFlags.Ephemeral] }).catch(e => console.error("Gagal mengirim 'followUp' error:", e));
        } else {
            await interaction.reply({ content: '❌ Terjadi kesalahan saat memproses permintaan Anda.', flags: [MessageFlags.Ephemeral] }).catch(e => console.error("Gagal mengirim 'reply' error:", e));
        }
    }
}); 

client.login(process.env.DISCORD_TOKEN);
