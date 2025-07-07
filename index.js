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
function splitTextIntoChunks(text, chunkSize = 1024) {
    const chunks = [];
    if (!text) return ['Tidak ada stack trace.'];
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
                new ButtonBuilder().setCustomId('view_servers_start').setLabel('Lihat Server').setStyle(ButtonStyle.Secondary).setEmoji('👀'),
                new ButtonBuilder().setCustomId('pull_image_init').setLabel('Pull Image').setStyle(ButtonStyle.Secondary).setEmoji('📥'),
                new ButtonBuilder().setCustomId('git_clone_init').setLabel('Git Clone').setStyle(ButtonStyle.Secondary).setEmoji('🔀')
            );
            await interaction.reply({ content: 'Pilih tindakan yang ingin Anda lakukan:', components: [initialRow], flags: [MessageFlags.Ephemeral] });
            return;
        }

        // ================== MODAL SUBMISSIONS ==================
        if (interaction.isModalSubmit()) {
            const modalIdParts = interaction.customId.split(':');
            const modalType = modalIdParts[0];
            const contextId = modalIdParts[1];

            if (modalType === 'add_server_modal') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
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
                const selectDbMenu = new StringSelectMenuBuilder().setCustomId(`save_to_db:${interaction.id}`).setPlaceholder('Pilih database tujuan untuk menyimpan server').addOptions(dbOptions.slice(0, 25));
                await interaction.editReply({ content: `Server **${name}** siap disimpan. Silakan pilih database tujuan:`, components: [new ActionRowBuilder().addComponents(selectDbMenu)] });

            } else if (modalType === 'multi_deploy_add_modal') {
                await interaction.deferUpdate();
                const sessionId = contextId;
                const session = deploymentSessions.get(sessionId);
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

                const panelMessage = await client.channels.cache.get(session.channelId)?.messages.fetch(session.panelMessageId);
                if (!panelMessage) throw new Error("Panel pesan untuk sesi ini tidak ditemukan.");

                const multiSelectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`multi_deploy_selection:${sessionId}`)
                    .setPlaceholder('Pilih server yang sudah ada')
                    .setMinValues(0).setMaxValues(Math.max(1, serverOptions.length))
                    .addOptions(serverOptions.length > 0 ? serverOptions : [{ label: 'Tidak ada server', value: 'no_server' }]);
                const actionRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`multi_deploy_add_new:${sessionId}`).setLabel('Tambah Server Baru').setStyle(ButtonStyle.Success).setEmoji('➕'),
                    new ButtonBuilder().setCustomId(`multi_deploy_execute:${sessionId}`).setLabel('Jalankan Deploy').setStyle(ButtonStyle.Primary).setEmoji('🚀')
                );

                await panelMessage.edit({
                    content: `✅ Server "${name}" berhasil ditambahkan! Daftar di bawah sudah diperbarui.`,
                    components: [new ActionRowBuilder().addComponents(multiSelectMenu), actionRow]
                });
            } else if (modalType === 'pull_image_modal') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pageId = contextId;
                const imageName = interaction.fields.getTextInputValue('imageName');

                const page = await notion.pages.retrieve({ page_id: pageId });
                const name = page.properties.Name.title[0].plain_text;
                await interaction.editReply(`⚙️ Anda memilih **${name}**. Mengambil detail dan mengirimkan tugas pull image **${imageName}**...`);
                
                const ip = page.properties.IP.rich_text[0].plain_text;
                const username = page.properties.Username.rich_text[0].plain_text;
                const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
                const codeBlock = blocksResponse.results.find(block => block.type === 'code');
                if (!codeBlock) return interaction.editReply(`❌ Tidak dapat menemukan Private Key untuk server ${name}.`);
                const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join('');

                const payload = { 
                    action: 'pull_image', 
                    imageName: imageName,
                    server: { pageId, ip, username, privateKey }, 
                    requestedBy: interaction.user.tag 
                };

                const success = await triggerN8nWebhook(payload);

                if (success) {
                  await interaction.followUp({ content: `✅ Tugas pull image **${imageName}** untuk server **${name}** berhasil dikirim ke n8n!`, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: `⚠️ Gagal mengirim tugas pull image untuk server **${name}** ke n8n.`, flags: [MessageFlags.Ephemeral] });
                }
            } else if (modalType === 'git_clone_modal') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pageId = contextId;
                const repoUrl = interaction.fields.getTextInputValue('repoUrl');
                const destPath = interaction.fields.getTextInputValue('destPath');

                const gitUsername = interaction.fields.getTextInputValue('gitUsername');
                const gitPassword = interaction.fields.getTextInputValue('gitPassword');
                const gitBranch = interaction.fields.getTextInputValue('gitBranch'); // <<< PENAMBAHAN UNTUK BRANCH

                const page = await notion.pages.retrieve({ page_id: pageId });
                const name = page.properties.Name.title[0].plain_text;
                await interaction.editReply(`⚙️ Anda memilih **${name}**. Mengambil detail dan mengirimkan tugas git clone dari **${repoUrl}**...`);
                
                const ip = page.properties.IP.rich_text[0].plain_text;
                const username = page.properties.Username.rich_text[0].plain_text;
                const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
                const codeBlock = blocksResponse.results.find(block => block.type === 'code');
                if (!codeBlock) return interaction.editReply(`❌ Tidak dapat menemukan Private Key untuk server ${name}.`);
                const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join('');

                const payload = { 
                    action: 'git_clone', 
                    repoUrl: repoUrl,
                    destPath: destPath,
                    server: { pageId, ip, username, privateKey }, 
                    requestedBy: interaction.user.tag 
                };

                if (gitUsername) {
                    payload.gitUsername = gitUsername;
                }
                if (gitPassword) {
                    payload.gitPassword = gitPassword;
                }
                if (gitBranch) { // <<< PENAMBAHAN UNTUK BRANCH
                    payload.gitBranch = gitBranch;
                }

                const success = await triggerN8nWebhook(payload);

                if (success) {
                    await interaction.followUp({ content: `✅ Tugas git clone untuk server **${name}** berhasil dikirim ke n8n!`, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: `⚠️ Gagal mengirim tugas git clone untuk server **${name}** ke n8n.`, flags: [MessageFlags.Ephemeral] });
                }
            }
            return; 
        }

        // ================== BUTTON CLICKS ==================
        if (interaction.isButton()) {
            const customIdParts = interaction.customId.split(':');
            const customId = customIdParts[0];
            const contextId = customIdParts[1];

            if (customId === 'add_server_start' || customId === 'multi_deploy_add_new') {
                const isMultiDeploy = customId === 'multi_deploy_add_new';
                const modal = new ModalBuilder()
                    .setCustomId(isMultiDeploy ? `multi_deploy_add_modal:${contextId}` : 'add_server_modal')
                    .setTitle(isMultiDeploy ? 'Tambah Server ke Sesi Deploy' : 'Tambah Konfigurasi Server Baru');
                
                const nameInput = new TextInputBuilder().setCustomId('serverName').setLabel("Nama Server").setStyle(TextInputStyle.Short).setRequired(true);
                const ipInput = new TextInputBuilder().setCustomId('serverIp').setLabel("IP Address Server").setStyle(TextInputStyle.Short).setRequired(true);
                const userInput = new TextInputBuilder().setCustomId('serverUser').setLabel("Username SSH").setStyle(TextInputStyle.Short).setRequired(true);
                const keyInput = new TextInputBuilder().setCustomId('serverKey').setLabel("Private Key SSH").setStyle(TextInputStyle.Paragraph).setRequired(true);
                
                modal.addComponents(
                    new ActionRowBuilder().addComponents(nameInput), 
                    new ActionRowBuilder().addComponents(ipInput), 
                    new ActionRowBuilder().addComponents(userInput), 
                    new ActionRowBuilder().addComponents(keyInput)
                );
                await interaction.showModal(modal);

            } else if (customId === 'run_deploy_start') {
                await interaction.deferUpdate();
                const deployModeRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('single_deploy_init').setLabel('Single Deploy').setStyle(ButtonStyle.Secondary).setEmoji('▶️'),
                    new ButtonBuilder().setCustomId('multi_deploy_init').setLabel('Multi Deploy').setStyle(ButtonStyle.Success).setEmoji('🚀'),
                );
                await interaction.editReply({ content: 'Pilih mode deploy:', components: [deployModeRow] });

            } else if (customId === 'view_servers_start' || customId === 'single_deploy_init' || customId === 'multi_deploy_init' || customId === 'pull_image_init' || customId === 'git_clone_init') {
                await interaction.deferUpdate();
                const searchResponse = await notion.search({ filter: { value: 'database', property: 'object' } });
                if (searchResponse.results.length === 0) return interaction.editReply({ content: '❌ Bot tidak memiliki akses ke database manapun.', components: [] });
                
                let actionType;
                if(customId === 'view_servers_start') actionType = 'view';
                else if(customId === 'single_deploy_init') actionType = 'single_run';
                else if(customId === 'multi_deploy_init') actionType = 'multi_run';
                else if(customId === 'pull_image_init') actionType = 'pull_image_run'; 
                else if(customId === 'git_clone_init') actionType = 'git_clone_run';

                const dbOptions = searchResponse.results.map(db => ({
                    label: (db.title[0]?.plain_text || 'Database tanpa nama').substring(0, 100),
                    description: `ID: ${db.id}`.substring(0, 100),
                    value: `${db.id}|${actionType}`,
                }));
                const selectDbMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_db')
                    .setPlaceholder('Langkah 1: Pilih database yang akan digunakan')
                    .addOptions(dbOptions.slice(0, 25));
                await interaction.editReply({ content: 'Silakan pilih database:', components: [new ActionRowBuilder().addComponents(selectDbMenu)] });
            
            } else if (customId === 'multi_deploy_execute') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const sessionId = contextId;
                const session = deploymentSessions.get(sessionId);
                if (!session) return interaction.editReply({ content: '❌ Sesi deploy tidak ditemukan atau sudah berakhir.' });

                const panelMessage = await client.channels.cache.get(session.channelId)?.messages.fetch(session.panelMessageId).catch(() => null);
                if (panelMessage) await panelMessage.delete();

                const combinedIds = new Set([...session.newlyAdded, ...session.selectedFromMenu]);
                if (combinedIds.size === 0) {
                    deploymentSessions.delete(sessionId);
                    return interaction.editReply({ content: '❌ Tidak ada server yang dipilih atau ditambahkan. Proses dibatalkan.' });
                }

                await interaction.editReply({ content: `Menggabungkan ${combinedIds.size} server dan mengirim tugas ke n8n...` });

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
                    await interaction.followUp({ content: `🚀 Tugas multi-deploy berhasil dikirim!`, flags: [MessageFlags.Ephemeral] });
                } else {
                    await interaction.followUp({ content: `❌ Gagal mengirim batch tugas ke n8n.`, flags: [MessageFlags.Ephemeral] });
                }
                deploymentSessions.delete(sessionId);
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
                // ... (Logika save_to_db tetap sama)
            
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
                    // ... (Logika 'view' tetap sama)
                } else if (actionType === 'single_run') {
                    // ... (Logika 'single_run' tetap sama)
                } else if (actionType === 'multi_run') {
                    // ... (Logika 'multi_run' yang sudah diperbaiki tetap sama)
                
                } else if (actionType === 'pull_image_run') {
                    if (allServers.length === 0) return interaction.editReply({ content: '❌ Database ini kosong, tidak ada server untuk dipilih.', components: [] });
                    
                    const selectServerMenu = new StringSelectMenuBuilder()
                          .setCustomId('pull_image_select_server')
                        .setPlaceholder('Langkah 2: Pilih server tujuan')
                        .addOptions(serverOptions.slice(0, 25));

                    await interaction.editReply({ content: 'Silakan pilih server untuk melakukan pull image:', components: [new ActionRowBuilder().addComponents(selectServerMenu)] });
                
                } else if (actionType === 'git_clone_run') {
                    if (allServers.length === 0) return interaction.editReply({ content: '❌ Database ini kosong, tidak ada server untuk dipilih.', components: [] });

                    const selectServerMenu = new StringSelectMenuBuilder()
                        .setCustomId('git_clone_select_server')
                        .setPlaceholder('Langkah 2: Pilih server tujuan')
                        .addOptions(serverOptions.slice(0, 25));

                    await interaction.editReply({ content: 'Silakan pilih server untuk melakukan git clone:', components: [new ActionRowBuilder().addComponents(selectServerMenu)] });
                }

            } else if (customId.startsWith('multi_deploy_selection')) {
                // ... (Logika multi_deploy_selection tetap sama)

            } else if (customId === 'select_server_for_update' || customId === 'execute_single_deploy') {
                // ... (Logika ini tetap sama)
            
            } else if (customId === 'pull_image_select_server') {
                const pageId = interaction.values[0];
                const modal = new ModalBuilder()
                    .setCustomId(`pull_image_modal:${pageId}`)
                    .setTitle('Pull Docker Image');
                
                const imageNameInput = new TextInputBuilder()
                    .setCustomId('imageName')
                    .setLabel("Nama Image (contoh: nginx:latest)")
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                
                modal.addComponents(new ActionRowBuilder().addComponents(imageNameInput));
                await interaction.showModal(modal);

            } else if (customId === 'git_clone_select_server') {
                const pageId = interaction.values[0];
                const modal = new ModalBuilder()
                    .setCustomId(`git_clone_modal:${pageId}`)
                    .setTitle('Git Clone Repository');

                const repoUrlInput = new TextInputBuilder()
                    .setCustomId('repoUrl')
                    .setLabel("URL Repository Git")
                    .setPlaceholder('https://github.com/user/repo.git')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);
                    
                const destPathInput = new TextInputBuilder()
                    .setCustomId('destPath')
                    .setLabel("Path Tujuan di Server")
                    .setPlaceholder('/var/www/my-project')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const gitUsernameInput = new TextInputBuilder()
                    .setCustomId('gitUsername')
                    .setLabel("Username Git (Opsional)")
                    .setPlaceholder('Biarkan kosong jika repositori publik')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const gitPasswordInput = new TextInputBuilder()
                    .setCustomId('gitPassword')
                    .setLabel("Password/Token Git (Opsional)")
                    .setPlaceholder('Gunakan Personal Access Token untuk keamanan')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const gitBranchInput = new TextInputBuilder() // <<< PENAMBAHAN UNTUK BRANCH
                    .setCustomId('gitBranch')
                    .setLabel("Branch (Opsional)")
                    .setPlaceholder('Biarkan kosong untuk branch default (e.g., main)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(repoUrlInput),
                    new ActionRowBuilder().addComponents(destPathInput),
                    new ActionRowBuilder().addComponents(gitUsernameInput),
                    new ActionRowBuilder().addComponents(gitPasswordInput),
                    new ActionRowBuilder().addComponents(gitBranchInput) // <<< PENAMBAHAN UNTUK BRANCH
                );
                await interaction.showModal(modal);
            }
        }
    } catch (error) {
        const errorId = interaction.id;
        console.error(`[Error ID: ${errorId}] Terjadi error pada interaksi (CustomID: ${interaction.customId || 'N/A'}):`, error);

        const logChannelId = process.env.DISCORD_LOG_CHANNEL_ID;
        if (logChannelId) {
            try {
                const logChannel = await client.channels.fetch(logChannelId);
                if (logChannel && logChannel.isTextBased()) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle(`⚠️ Bot Error Ditemukan!`)
                        .addFields(
                            { name: 'Error ID', value: `\`${errorId}\``, inline: true },
                            { name: 'Pengguna', value: `${interaction.user.tag} (\`${interaction.user.id}\`)`, inline: true },
                            { name: 'Interaction', value: `\`${interaction.customId || 'Command: ' + (interaction.commandName || 'N/A')}\``, inline: false },
                            { name: 'Pesan Error', value: `\`\`\`${String(error.message || 'Tidak ada pesan error.').substring(0, 1000)}\`\`\`` }
                        )
                        .setTimestamp();

                    const stackChunks = splitTextIntoChunks(error.stack);
                    for(let i = 0; i < stackChunks.length && i < 2; i++) {
                        errorEmbed.addFields({ name: `Stack Trace (Bagian ${i+1})`, value: `\`\`\`${stackChunks[i]}\`\`\`` });
                    }
                    
                    await logChannel.send({ embeds: [errorEmbed] });
                }
            } catch (logError) {
                console.error("KRITIS: Gagal mengirim log error ke channel log!", logError);
            }
        }

        const userMessage = `❌ Terjadi kesalahan internal. Mohon laporkan **Error ID** berikut ke admin: \`${errorId}\``;
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: userMessage, flags: [MessageFlags.Ephemeral] }).catch(e => console.error("Gagal mengirim 'followUp' error:", e));
        } else {
            await interaction.reply({ content: userMessage, flags: [MessageFlags.Ephemeral] }).catch(e => console.error("Gagal mengirim 'reply' error:", e));
        }
    }
}); 

client.login(process.env.DISCORD_TOKEN);
