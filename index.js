// Mengimpor semua komponen yang dibutuhkan
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { fetch } = require('undici');
const { Client: NotionClient } = require('@notionhq/client');
require('dotenv').config();

// Inisialisasi
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const notion = new NotionClient({ auth: process.env.NOTION_KEY });

// Variabel untuk menyimpan data sementara
const pendingSaves = new Map();


// --- FUNGSI BANTUAN ---
/**
 * Memecah teks menjadi beberapa bagian dengan ukuran maksimal.
 * @param {string} text Teks yang akan dipecah.
 * @param {number} chunkSize Ukuran maksimal setiap bagian.
 * @returns {string[]} Array berisi bagian-bagian teks.
 */
function splitTextIntoChunks(text, chunkSize = 1024) {
    const chunks = [];
    if (!text) return ['Tidak ada stack trace.'];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

/**
 * Mengirim payload ke webhook n8n.
 * @param {object} payload Data yang akan dikirim.
 * @returns {Promise<boolean>} True jika berhasil, false jika gagal.
 */
async function triggerN8nWebhook(payload) {
    if (!process.env.N8N_WEBHOOK_URL) {
        console.error("N8N_WEBHOOK_URL tidak diatur di file .env");
        return false;
    }
    try {
        const response = await fetch(process.env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return response.ok;
    } catch (error) {
        console.error('Error saat mengirim ke n8n:', error);
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
                new ButtonBuilder().setCustomId('run_deploy_init').setLabel('Jalankan Deploy').setStyle(ButtonStyle.Primary).setEmoji('🚀'),
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
            const modalType = modalIdParts.shift();
            const contextId = modalIdParts.join(':');

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
                    label: (db.title?.[0]?.plain_text || 'Database tanpa nama').substring(0, 100),
                    description: `ID: ${db.id}`.substring(0, 100),
                    value: db.id,
                }));
                const selectDbMenu = new StringSelectMenuBuilder().setCustomId(`save_to_db:${interaction.id}`).setPlaceholder('Pilih database tujuan untuk menyimpan server').addOptions(dbOptions.slice(0, 25));
                await interaction.editReply({ content: `Server **${name}** siap disimpan. Silakan pilih database tujuan:`, components: [new ActionRowBuilder().addComponents(selectDbMenu)] });

            } else if (modalType === 'pull_image_modal') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const pageId = contextId;
                const imageName = interaction.fields.getTextInputValue('imageName');

                const page = await notion.pages.retrieve({ page_id: pageId });
                const name = page.properties.Name.title?.[0]?.plain_text;
                await interaction.editReply(`⚙️ Anda memilih **${name}**. Mengambil detail dan mengirimkan tugas pull image **${imageName}**...`);

                const ip = page.properties.IP.rich_text?.[0]?.plain_text;
                const username = page.properties.Username.rich_text?.[0]?.plain_text;
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
                const gitBranch = interaction.fields.getTextInputValue('gitBranch');

                const page = await notion.pages.retrieve({ page_id: pageId });
                const name = page.properties.Name.title?.[0]?.plain_text;
                await interaction.editReply(`⚙️ Anda memilih **${name}**. Mengambil detail dan mengirimkan tugas git clone dari **${repoUrl}**...`);

                const ip = page.properties.IP.rich_text?.[0]?.plain_text;
                const username = page.properties.Username.rich_text?.[0]?.plain_text;
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

                if (gitUsername) payload.gitUsername = gitUsername;
                if (gitPassword) payload.gitPassword = gitPassword;
                if (gitBranch) payload.gitBranch = gitBranch;

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
            const customId = interaction.customId;

            if (customId === 'add_server_start') {
                const modal = new ModalBuilder()
                    .setCustomId('add_server_modal')
                    .setTitle('Tambah Konfigurasi Server Baru');

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

            } else if (['view_servers_start', 'run_deploy_init', 'pull_image_init', 'git_clone_init'].includes(customId)) {
                await interaction.deferUpdate();
                const searchResponse = await notion.search({ filter: { value: 'database', property: 'object' } });
                if (searchResponse.results.length === 0) return interaction.editReply({ content: '❌ Bot tidak memiliki akses ke database manapun.', components: [] });

                const actionMap = {
                    'view_servers_start': 'view',
                    'run_deploy_init': 'run_deploy',
                    'pull_image_init': 'pull_image_run',
                    'git_clone_init': 'git_clone_run'
                };
                const actionType = actionMap[customId];

                const dbOptions = searchResponse.results.map(db => ({
                    label: (db.title?.[0]?.plain_text || 'Database tanpa nama').substring(0, 100),
                    description: `ID: ${db.id}`.substring(0, 100),
                    value: `${db.id}|${actionType}`,
                }));
                const selectDbMenu = new StringSelectMenuBuilder()
                    .setCustomId('select_db')
                    .setPlaceholder('Langkah 1: Pilih database yang akan digunakan')
                    .addOptions(dbOptions.slice(0, 25));
                await interaction.editReply({ content: 'Silakan pilih database:', components: [new ActionRowBuilder().addComponents(selectDbMenu)] });
            }
            return;
        }

        // ================== SELECT MENUS ==================
        if (interaction.isStringSelectMenu()) {
            const customIdParts = interaction.customId.split(':');
            const customId = customIdParts.shift();
            const contextId = customIdParts.join(':');

            if (customId === 'save_to_db') {
                await interaction.deferUpdate();
                const selectedDbId = interaction.values?.[0];
                if (!selectedDbId) return interaction.editReply({ content: '❌ Tidak ada database yang dipilih.', components: [] });
                const serverData = pendingSaves.get(contextId);
                if (!serverData) return interaction.editReply({ content: '❌ Data server sementara tidak ditemukan atau sesi telah berakhir.', components: [] });

                try {
                    const keyChunks = splitTextIntoChunks(serverData.privateKey);
                    const richTextChunks = keyChunks.map(chunk => ({ type: 'text', text: { content: chunk } }));
                    await notion.pages.create({
                        parent: { database_id: selectedDbId },
                        properties: {
                            Name: { title: [{ text: { content: serverData.name } }] },
                            IP: { rich_text: [{ text: { content: serverData.ip } }] },
                            Username: { rich_text: [{ text: { content: serverData.username } }] },
                        },
                        children: [{ object: 'block', type: 'code', code: { rich_text: richTextChunks, language: 'shell' } }],
                    });
                    await interaction.editReply({ content: `✅ Server **${serverData.name}** berhasil disimpan!`, components: [] });
                } catch (error) {
                    console.error('Error saving to Notion:', error);
                    await interaction.editReply({ content: `❌ Gagal menyimpan server ke Notion. Pastikan bot memiliki izin yang benar.`, components: [] });
                } finally {
                    pendingSaves.delete(contextId);
                }

            } else if (customId === 'select_db') {
                await interaction.deferUpdate();
                const [selectedDbId, actionType] = interaction.values?.[0]?.split('|') || [];
                if (!selectedDbId || !actionType) return interaction.editReply({ content: '❌ Pilihan tidak valid.', components: [] });

                const response = await notion.databases.query({ database_id: selectedDbId });
                const allServers = response.results;
                const serverOptions = allServers.map(page => ({
                    label: page.properties.Name?.title?.[0]?.plain_text || 'Server Tanpa Nama',
                    description: `IP: ${page.properties.IP?.rich_text?.[0]?.plain_text || 'N/A'}`,
                    value: page.id,
                }));

                if (allServers.length === 0) {
                    return interaction.editReply({ content: '❌ Database ini kosong, tidak ada server untuk dipilih.', components: [] });
                }

                if (actionType === 'view') {
                    const embed = new EmbedBuilder()
                        .setTitle(`Daftar Server`)
                        .setColor(0x5865F2);
                    let description = `Menampilkan ${allServers.length} server:\n\n`;
                    allServers.forEach(server => {
                        const name = server.properties.Name?.title?.[0]?.plain_text || 'Server Tanpa Nama';
                        const ip = server.properties.IP?.rich_text?.[0]?.plain_text || 'N/A';
                        description += `**${name}** - \`${ip}\`\n`;
                    });
                    embed.setDescription(description);
                    await interaction.editReply({ embeds: [embed], components: [] });

                } else if (actionType === 'run_deploy') {
                    const selectServerMenu = new StringSelectMenuBuilder()
                        .setCustomId('execute_deploy')
                        .setPlaceholder('Pilih satu atau lebih server untuk deploy')
                        .setMinValues(1)
                        .setMaxValues(Math.min(25, allServers.length))
                        .addOptions(serverOptions.slice(0, 25));
                    await interaction.editReply({ content: 'Silakan pilih server yang akan Anda deploy (bisa lebih dari satu):', components: [new ActionRowBuilder().addComponents(selectServerMenu)] });

                } else if (actionType === 'pull_image_run') {
                    const selectServerMenu = new StringSelectMenuBuilder()
                        .setCustomId('pull_image_select_server')
                        .setPlaceholder('Langkah 2: Pilih server tujuan')
                        .addOptions(serverOptions.slice(0, 25));
                    await interaction.editReply({ content: 'Silakan pilih server untuk melakukan pull image:', components: [new ActionRowBuilder().addComponents(selectServerMenu)] });

                } else if (actionType === 'git_clone_run') {
                    const selectServerMenu = new StringSelectMenuBuilder()
                        .setCustomId('git_clone_select_server')
                        .setPlaceholder('Langkah 2: Pilih server tujuan')
                        .addOptions(serverOptions.slice(0, 25));
                    await interaction.editReply({ content: 'Silakan pilih server untuk melakukan git clone:', components: [new ActionRowBuilder().addComponents(selectServerMenu)] });
                }

            } else if (customId === 'execute_deploy') {
                await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
                const selectedPageIds = interaction.values;
                if (!selectedPageIds || selectedPageIds.length === 0) {
                    return interaction.editReply({ content: '❌ Tidak ada server yang dipilih.' });
                }

                await interaction.editReply({ content: `Mengambil detail untuk ${selectedPageIds.length} server dan mengirimkan tugas deploy ke n8n...` });

                try {
                    const serverDetailsPromises = selectedPageIds.map(async (pageId) => {
                        const page = await notion.pages.retrieve({ page_id: pageId });
                        const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
                        const codeBlock = blocksResponse.results.find(block => block.type === 'code');
                        
                        const name = page.properties.Name?.title?.[0]?.plain_text;
                        const ip = page.properties.IP?.rich_text?.[0]?.plain_text;
                        const username = page.properties.Username?.rich_text?.[0]?.plain_text;

                        if (!ip || !username || !codeBlock) {
                            console.warn(`Data tidak lengkap untuk server ${name || pageId}, server ini dilewati.`);
                            return null; // Lewati server yang datanya tidak lengkap
                        }
                        const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join('');
                        return { pageId, ip, username, privateKey, name };
                    });

                    const servers = (await Promise.all(serverDetailsPromises)).filter(Boolean); // Filter null

                    if (servers.length === 0) {
                        return interaction.followUp({ content: '❌ Semua server yang dipilih datanya tidak lengkap dan tidak dapat diproses.', flags: [MessageFlags.Ephemeral] });
                    }

                    const payload = {
                        action: 'deploy',
                        servers: servers.map(({name, ...rest}) => rest), // Hapus nama dari payload akhir jika tidak diperlukan n8n
                        requestedBy: interaction.user.tag,
                    };

                    const success = await triggerN8nWebhook(payload);
                    const serverNames = servers.map(s => `**${s.name}**`).join(', ');

                    if (success) {
                        await interaction.followUp({ content: `🚀 Tugas deploy untuk server ${serverNames} berhasil dikirim!`, flags: [MessageFlags.Ephemeral] });
                    } else {
                        await interaction.followUp({ content: `❌ Gagal mengirim batch tugas deploy untuk server ${serverNames} ke n8n.`, flags: [MessageFlags.Ephemeral] });
                    }
                } catch (error) {
                    console.error('Error during deploy execution:', error);
                    await interaction.followUp({ content: `❌ Terjadi kesalahan saat memproses tugas deploy.`, flags: [MessageFlags.Ephemeral] });
                }


            } else if (customId === 'pull_image_select_server') {
                const pageId = interaction.values?.[0];
                if (!pageId) return;
                const modal = new ModalBuilder()
                    .setCustomId(`pull_image_modal:${pageId}`)
                    .setTitle('Pull Docker Image');
                const imageNameInput = new TextInputBuilder().setCustomId('imageName').setLabel("Nama Image (contoh: nginx:latest)").setStyle(TextInputStyle.Short).setRequired(true);
                modal.addComponents(new ActionRowBuilder().addComponents(imageNameInput));
                await interaction.showModal(modal);

            } else if (customId === 'git_clone_select_server') {
                const pageId = interaction.values?.[0];
                if (!pageId) return;
                const modal = new ModalBuilder().setCustomId(`git_clone_modal:${pageId}`).setTitle('Git Clone Repository');
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('repoUrl').setLabel("URL Repository Git").setPlaceholder('https://github.com/user/repo.git').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('destPath').setLabel("Path Tujuan di Server").setPlaceholder('/var/www/my-project').setStyle(TextInputStyle.Short).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gitUsername').setLabel("Username Git (Opsional)").setStyle(TextInputStyle.Short).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gitPassword').setLabel("Password/Token Git (Opsional)").setStyle(TextInputStyle.Short).setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('gitBranch').setLabel("Branch (Opsional, default: main)").setStyle(TextInputStyle.Short).setRequired(false))
                );
                await interaction.showModal(modal);
            }
        }
    } catch (error) {
        const errorId = interaction.id || 'unknown';
        console.error(`[Error ID: ${errorId}] Terjadi error pada interaksi (CustomID: ${interaction.customId || 'N/A'}):`, error);

        const logChannelId = process.env.DISCORD_LOG_CHANNEL_ID;
        if (logChannelId) {
            try {
                const logChannel = await client.channels.fetch(logChannelId);
                if (logChannel?.isTextBased()) {
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
                    for (let i = 0; i < stackChunks.length && i < 2; i++) {
                        errorEmbed.addFields({ name: `Stack Trace (Bagian ${i + 1})`, value: `\`\`\`${stackChunks[i]}\`\`\`` });
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
