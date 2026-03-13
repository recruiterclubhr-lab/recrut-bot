// Standalone Baileys worker - completely independent from Next.js
const makeWASocket = require('@whiskeysockets/baileys').default;
const { DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { useSupabaseAuthState } = require('./baileys-auth-standalone.js');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');

const logger = pino({ level: 'info' });

// Hardcoded fallbacks from src/lib/server/db.ts
const SUPABASE_URL_FALLBACK = 'https://zrctubjaqyyhtiumdtau.supabase.co';
const SUPABASE_KEY_FALLBACK = 'sb_secret_mVTgwJkcXOWrFC9KhqNCcg_WLVf1nVA';

const supabaseUrl = process.env.SUPABASE_URL || SUPABASE_URL_FALLBACK;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPABASE_KEY_FALLBACK;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const { callGemini } = require('./gemini-worker.js');

// Utility functions
function normalizeText(text) {
    if (!text) return '';
    return text.toString().toLowerCase().trim().replace(/\s+/g, ' ');
}

function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function hasOptOut(text) {
    const opts = ['стоп', 'stop', 'нет', 'не надо', 'отписка', 'unsubscribe', 'out', 'спам'];
    return opts.some(o => text.includes(o));
}

function hasOptIn(text) {
    const opts = ['старт', 'start', 'go', 'поехали', 'привет', 'hi', 'hello'];
    return opts.some(o => text.includes(o));
}

// Polling for scheduled messages
let isPolling = false;
async function pollScheduledMessages(sock, supabase) {
    if (isPolling) return;
    isPolling = true;

    while (true) {
        try {
            const { data: pending, error } = await supabase
                .from('scheduled_messages')
                .select('id, contact_id, message_text')
                .eq('status', 'pending')
                .lte('scheduled_at', new Date().toISOString())
                .limit(10);

            if (error) throw error;

            if (pending && pending.length > 0) {
                console.log(`📤 [Baileys Worker] Найдено ${pending.length} запланированных сообщений`);
                for (const msg of pending) {
                    const { data: contact } = await supabase.from('contacts').select('wa_chat_id').eq('id', msg.contact_id).single();
                    if (contact) {
                        try {
                            await sock.sendMessage(contact.wa_chat_id, { text: msg.message_text });
                            await supabase.from('scheduled_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', msg.id);
                            console.log(`✅ [Baileys Worker] Отправлено запланированное сообщение для ${contact.wa_chat_id}`);
                        } catch (sendErr) {
                            console.error(`❌ [Baileys Worker] Ошибка отправки: ${sendErr.message}`);
                        }
                    } else {
                        await supabase.from('scheduled_messages').update({ status: 'failed' }).eq('id', msg.id);
                    }
                    await sleep(1000);
                }
            }
        } catch (err) {
            console.error('⚠️ [Baileys Worker] Ошибка в планировщике:', err.message);
        }
        await sleep(60000); // Check every minute
    }
}

async function startBaileys() {
    const { state, saveCreds } = await useSupabaseAuthState('main-session', supabase);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['Recruiter Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('💠 [Baileys] QR-код для сканирования:');
            qrcode.generate(qr, { small: true });
            console.log('Строка для ручного копирования (на всякий случай):');
            console.log(qr);
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            const errorMsg = lastDisconnect?.error?.message || (lastDisconnect?.error && lastDisconnect.error.toString()) || '';

            if (errorMsg.includes('Bad MAC')) {
                console.error('🛑 Critical Connection Error: Bad MAC. Clearing auth and restarting...');
                await supabase.from('baileys_auth').delete().eq('session_id', 'main-session');
                process.exit(1);
            }

            console.log('💠 [Baileys] Соединение закрыто. Переподключение:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(() => startBaileys(), 5000);
            }
        } else if (connection === 'open') {
            console.log('💠 [Baileys] Соединение установлено успешно!');
            pollScheduledMessages(sock, supabase).catch(err => console.error('❌ [Baileys Scheduler] Critical:', err));
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const chatId = msg.key.remoteJid;
            const rawText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            const userText = normalizeText(rawText);

            if (!userText) continue;

            console.log(`📬 [Baileys] Сообщение от ${chatId}: ${rawText}`);

            try {
                // 0. Opt-in check (restore if previously opted out)
                if (hasOptIn(userText)) {
                    console.log(`✅ [Baileys] Opt-in detected for ${chatId}`);
                    await supabase.from('contacts').update({ opt_out: false }).eq('wa_chat_id', chatId);
                    // We need to re-fetch the contact to see the updated status
                }

                // 1. Opt-out check
                if (hasOptOut(userText)) {
                    console.log(`🚫 [Baileys] Opt-out detected for ${chatId}`);
                    await supabase.from('contacts').upsert({ wa_chat_id: chatId, opt_out: true, updated_at: new Date().toISOString() }, { onConflict: 'wa_chat_id' });
                    continue;
                }

                // 2. Get/Create Contact
                console.log(`🔍 [Baileys] Looking up contact for ${chatId}...`);
                let { data: contact, error: fetchError } = await supabase.from('contacts').select('*').eq('wa_chat_id', chatId).maybeSingle();

                if (fetchError) {
                    console.error(`❌ [Baileys] Contact fetch error:`, fetchError);
                }

                const isNewContact = !contact;

                if (!contact) {
                    console.log(`🆕 [Baileys] Creating new contact for ${chatId}...`);
                    const { data: inserted, error: insertError } = await supabase.from('contacts').insert({ wa_chat_id: chatId, stage: 'start' }).select('*').single();
                    if (insertError) {
                        console.error(`❌ [Baileys] Contact insert error:`, insertError);
                        // Try to fetch again in case of race condition
                        let { data: retryContact } = await supabase.from('contacts').select('*').eq('wa_chat_id', chatId).maybeSingle();
                        contact = retryContact;
                    } else {
                        contact = inserted;
                    }
                } else if (contact.opt_out) {
                    console.log(`🚫 [Baileys] Contact ${chatId} has opted out.`);
                    continue;
                }

                if (!contact) {
                    console.error(`❌ [Baileys] Failed to get or create contact for ${chatId}. Skipping.`);
                    continue;
                }

                console.log(`✅ [Baileys] Contact ready: ${contact.id} (Stage: ${contact.stage})`);

                // 3. Deduplication: Check if message already exists
                const { data: existingMsg } = await supabase.from('messages').select('id').eq('provider_message_id', msg.key.id).maybeSingle();
                if (existingMsg) {
                    console.log(`⚠️ [Baileys] Message ${msg.key.id} already processed (found in DB). Skipping.`);
                    continue;
                }

                // 4. Store message
                const { error: msgError } = await supabase.from('messages').insert({
                    contact_id: contact.id,
                    direction: 'in',
                    provider_message_id: msg.key.id,
                    text: rawText
                });

                if (msgError) {
                    // Check for unique violation (Postgres code 23505)
                    if (msgError.code === '23505' || msgError.message?.includes('duplicate key')) {
                        console.log(`⚠️ [Baileys] Message ${msg.key.id} already processed (insert conflict). Skipping.`);
                        continue;
                    }
                    console.error(`⚠️ [Baileys] Message save error:`, msgError);
                }

                // 4. Load settings
                const { data: settingsRows } = await supabase.from('settings').select('key, value');
                const settings = {};
                (settingsRows || []).forEach(row => settings[row.key] = row.value);

                // 5. Build context & Call Gemini
                const { data: recentMsgs } = await supabase
                    .from('messages')
                    .select('direction,text')
                    .eq('contact_id', contact.id)
                    .order('created_at', { ascending: true })
                    .limit(20);

                const memory = {
                    summary: contact.summary || '',
                    recent: (recentMsgs || []).map(m => ({ direction: m.direction, text: m.text }))
                };

                const fullPrompt = [
                    settings['system_prompt'] || '',
                    settings['tone'] ? `\nТон общения: ${settings['tone']}` : '',
                    settings['site_url'] ? `\nОсновной сайт: ${settings['site_url']}` : '',
                    settings['candidate_link'] ? `\nСсылка для кандидата: ${settings['candidate_link']}` : '',
                    settings['agency_link'] ? `\nСсылка для агентства: ${settings['agency_link']}` : '',
                ].join('\n');

                console.log('🤖 [Baileys] Зовём Gemini...');
                const ai = await callGemini({ systemPrompt: fullPrompt, userText: rawText, memory, stage: contact.stage });

                let reply = ai.reply || 'Извини, я не понял. Можешь повторить?';

                if (ai.need_link) {
                    const link = (ai.lead_type === 'agency' ? settings['agency_link'] : settings['candidate_link']) || settings['site_url'];
                    if (link) reply = `${reply}\n\nАнкета/регистрация: ${link}`;
                }

                // 6. Send Reply
                // Simulate typing
                await sock.readMessages([msg.key]);
                await sock.presenceSubscribe(chatId);
                await sleep(randInt(1000, 2000));
                await sock.sendPresenceUpdate('composing', chatId);
                await sleep(randInt(1500, 3000));
                await sock.sendPresenceUpdate('paused', chatId);

                await sock.sendMessage(chatId, { text: reply });
                console.log('✅ [Baileys] Ответ отправлен');

                // 7. Store outbound & update contact
                await supabase.from('messages').insert({
                    contact_id: contact.id,
                    direction: 'out',
                    provider_message_id: `out:${Date.now()}`,
                    text: reply
                });

                const nextStage = ai.next_stage || contact.stage;
                const newSummary = ai.memory_update
                    ? (contact.summary ? (contact.summary + '\n' + ai.memory_update) : ai.memory_update)
                    : contact.summary;

                await supabase.from('contacts').update({
                    stage: nextStage,
                    summary: (newSummary || '').slice(0, 2000),
                    lead_type: ai.lead_type || 'unknown',
                    updated_at: new Date().toISOString()
                }).eq('id', contact.id);

                // 8. Admin notification
                const adminPhone = settings['admin_phone'];
                if (isNewContact && adminPhone) {
                    try {
                        const senderName = chatId.split('@')[0];
                        const adminNotification = `🆕 Новый пользователь!\n\n📱 Номер: +${senderName}\n📝 Первое сообщение: "${rawText}"`;
                        await sock.sendMessage(adminPhone + '@c.us', { text: adminNotification });
                    } catch (e) {
                        console.error('⚠️ [Baileys] Ошибка уведомления админа:', e.message);
                    }
                }

                // 9. Schedule follow-up
                const followupEnabled = settings['followup_enabled'] === 'true';
                const followupMessage = settings['followup_message'];
                const followupDelayHours = parseInt(settings['followup_delay_hours'] || '24');

                if (isNewContact && followupEnabled && followupMessage) {
                    try {
                        const scheduledAt = new Date(Date.now() + followupDelayHours * 60 * 60 * 1000);
                        await supabase.from('scheduled_messages').insert({
                            contact_id: contact.id,
                            message_text: followupMessage,
                            scheduled_at: scheduledAt.toISOString(),
                        });
                        console.log(`📅 [Baileys] Запланирован фоллоу-ап`);
                    } catch (e) {
                        console.error('⚠️ [Baileys] Ошибка планирования фоллоу-апа:', e.message);
                    }
                }

            } catch (err) {
                console.error('❌ [Baileys] Ошибка при обработке:', err);
                if (err.message && err.message.includes('Bad MAC')) {
                    console.error('🛑 Critical Session Error: Bad MAC in message processing. Clearing session...');
                    await supabase.from('baileys_auth').delete().eq('session_id', 'main-session');
                    process.exit(1); // Restart worker to force new session
                }
            }
        }
    });
}

console.log('🚀 [Worker] Starting Baileys WhatsApp worker...');
startBaileys().catch((err) => {
    console.error('❌ [Worker] Fatal error:', err);
    process.exit(1);
});
