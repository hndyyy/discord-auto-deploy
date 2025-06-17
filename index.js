// Diubah: Menambahkan MessageFlags untuk perbaikan ephemeral
const { Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, MessageFlags } = require('discord.js');
const { fetch } = require('undici');
const { Client: NotionClient } = require('@notionhq/client');
require('dotenv').config();

// Inisialisasi Discord Client
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Inisialisasi Notion Client
const notion = new NotionClient({ auth: process.env.NOTION_KEY });
const databaseId = process.env.NOTION_DATABASE_ID;

// BARU: Fungsi untuk memecah teks menjadi potongan di bawah 2000 karakter
function splitTextIntoChunks(text, chunkSize = 2000) {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) {
        chunks.push(text.substring(i, i + chunkSize));
    }
    return chunks;
}

client.once(Events.ClientReady, () => {
    console.log(`Logged in as ${client.user.tag}`);
});

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

client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isChatInputCommand() && interaction.commandName === 'deploy') {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId('add_new_server').setLabel('Tambah Server Baru').setStyle(ButtonStyle.Success).setEmoji('➕'),
                new ButtonBuilder().setCustomId('run_existing_server').setLabel('Jalankan Server Tersimpan').setStyle(ButtonStyle.Primary).setEmoji('▶️'),
            );
        await interaction.reply({
            content: 'Silakan pilih tindakan yang ingin Anda lakukan:',
            components: [row],
            flags: [MessageFlags.Ephemeral]
        });
    }

    if (interaction.isButton()) {
        if (interaction.customId === 'add_new_server') {
            const modal = new ModalBuilder().setCustomId('add_server_modal').setTitle('Tambah Konfigurasi Server Baru');
            const nameInput = new TextInputBuilder().setCustomId('serverName').setLabel("Nama Server (cth: Server Staging)").setStyle(TextInputStyle.Short).setRequired(true);
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
        }

        if (interaction.customId === 'run_existing_server') {
            await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
            try {
                const response = await notion.databases.query({ database_id: databaseId });
                const servers = response.results.map(page => ({
                    label: page.properties.Name.title[0].plain_text,
                    description: `IP: ${page.properties.IP.rich_text.length > 0 ? page.properties.IP.rich_text[0].plain_text : 'Tidak ada IP'}`,
                    value: page.id,
                }));
                if (servers.length === 0) {
                    await interaction.editReply('❌ Tidak ada server yang tersimpan di Notion.');
                    return;
                }
                const row = new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder().setCustomId('select_server').setPlaceholder('Pilih server dari Notion').addOptions(servers)
                );
                await interaction.editReply({ content: 'Pilih server yang akan dijalankan:', components: [row] });
            } catch (error) {
                console.error("Error fetching from Notion:", error);
                await interaction.editReply('❌ Gagal mengambil data dari Notion.');
            }
        }
    }

    if (interaction.isModalSubmit() && interaction.customId === 'add_server_modal') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        const name = interaction.fields.getTextInputValue('serverName');
        const ip = interaction.fields.getTextInputValue('serverIp');
        const username = interaction.fields.getTextInputValue('serverUser');
        const privateKey = interaction.fields.getTextInputValue('serverKey');

        try {
            // DIUBAH: Logika untuk memecah private key
            const keyChunks = splitTextIntoChunks(privateKey);
            const richTextChunks = keyChunks.map(chunk => ({
                type: 'text',
                text: { content: chunk },
            }));

            await notion.pages.create({
                parent: { database_id: databaseId },
                properties: {
                    Name: { title: [{ text: { content: name } }] },
                    IP: { rich_text: [{ text: { content: ip } }] },
                    Username: { rich_text: [{ text: { content: username } }] },
                },
                children: [{
                    object: 'block',
                    type: 'code',
                    code: {
                        rich_text: richTextChunks, // Menggunakan array dari potongan rich_text
                        language: 'shell',
                    },
                }],
            });
            await interaction.editReply(`✅ Server "${name}" berhasil disimpan di Notion!`);

            const payload = { ip, username, privateKey, requestedBy: interaction.user.tag };
            const success = await triggerN8nWebhook(payload);
            if (success) {
                await interaction.followUp({ content: '🚀 Data juga berhasil dikirim ke n8n. Instalasi sedang diproses.', flags: [MessageFlags.Ephemeral] });
            } else {
                await interaction.followUp({ content: '⚠️ Gagal mengirim data ke n8n.', flags: [MessageFlags.Ephemeral] });
            }
        } catch (error) {
            console.error('Error saving to Notion:', error);
            await interaction.editReply('❌ Terjadi error saat menyimpan data ke Notion.');
        }
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_server') {
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
        try {
            const pageId = interaction.values[0];
            const page = await notion.pages.retrieve({ page_id: pageId });
            const ip = page.properties.IP.rich_text[0].plain_text;
            const username = page.properties.Username.rich_text[0].plain_text;
            const name = page.properties.Name.title[0].plain_text;

            // DIUBAH: Logika untuk menggabungkan kembali private key
            const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
            const codeBlock = blocksResponse.results.find(block => block.type === 'code');
            if (!codeBlock) {
                await interaction.editReply('❌ Tidak dapat menemukan Private Key di dalam halaman Notion.');
                return;
            }
            // Gabungkan semua potongan teks menjadi satu private key utuh
            const privateKey = codeBlock.code.rich_text.map(rt => rt.plain_text).join('');

            await interaction.editReply(`✅ Anda memilih server "${name}". Memproses instalasi...`);

            const payload = { ip, username, privateKey, requestedBy: interaction.user.tag };
            const success = await triggerN8nWebhook(payload);
            if (success) {
                await interaction.followUp({ content: '🚀 Data berhasil dikirim ke n8n. Instalasi sedang diproses.', flags: [MessageFlags.Ephemeral] });
            } else {
                await interaction.followUp({ content: '⚠️ Gagal mengirim data ke n8n.', flags: [MessageFlags.Ephemeral] });
            }
        } catch (error) {
            console.error("Error retrieving page/block from Notion:", error);
            await interaction.editReply('❌ Gagal mengambil detail server dari Notion.');
        }
    }
});

client.login(process.env.DISCORD_TOKEN);
