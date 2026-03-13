import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import { useSupabaseAuthState } from './baileys-auth';
import { supabaseAdmin } from './db';
import { callGemini } from './gemini';
import { normalizeText, hasOptOut, randInt, sleep } from './util';

let isPolling = false;

async function pollScheduledMessages(sock: any) {
    if (isPolling) return;
    isPolling = true;

    while (true) {
        try {
            const { data: pending, error } = await supabaseAdmin
                .from('scheduled_messages')
                .select('id, contact_id, message_text')
                .eq('status', 'pending')
                .lte('scheduled_at', new Date().toISOString())
                .limit(10);

            if (error) throw error;

            if (pending && pending.length > 0) {
                console.log(`📤 [Baileys Worker] Найдено ${pending.length} запланированных сообщений`);
                for (const msg of pending) {
                    const { data: contact } = await supabaseAdmin.from('contacts').select('wa_chat_id').eq('id', msg.contact_id).single();
                    if (contact) {
                        await sock.sendMessage(contact.wa_chat_id, { text: msg.message_text });
                        await supabaseAdmin.from('scheduled_messages').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', msg.id);
                        console.log(`✅ [Baileys Worker] Отправлено запланированное сообщение для ${contact.wa_chat_id}`);
                    } else {
                        await supabaseAdmin.from('scheduled_messages').update({ status: 'failed' }).eq('id', msg.id);
                    }
                    await sleep(1000); // Small delay between sends
                }
            }
        } catch (err) {
            console.error('⚠️ [Baileys Worker] Ошибка в планировщике:', err);
        }
        await sleep(60000); // Check every minute
    }
}

const logger = pino({ level: 'info' });

export async function startBaileys() {
    console.log('🚫 [Baileys] Main app logic DISABLED. Use standalone worker instead.');
    return;
    /*
    const { state, saveCreds } = await useSupabaseAuthState('main-session');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: ['Recruiter Bot', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('💠 [Baileys] Новый QR-код готов! Отсканируйте в логах Railway.');
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('💠 [Baileys] Соединение закрыто. Причина:', lastDisconnect?.error, 'Переподключение:', shouldReconnect);
            if (shouldReconnect) startBaileys();
        } else if (connection === 'open') {
            console.log('💠 [Baileys] Соединение установлено успешно!');
            pollScheduledMessages(sock).catch(err => console.error('❌ [Baileys Scheduler] Critical error:', err));
        }
    });

    sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            const chatId = msg.key.remoteJid!;
            const userText = normalizeText(
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                ''
            );

            if (!userText) continue;

            console.log(`📬 [Baileys] Сообщение от ${chatId}: ${userText}`);

            try {
                // 1. Opt-out check
                if (hasOptOut(userText)) {
                    await supabaseAdmin.from('contacts').upsert({ wa_chat_id: chatId, opt_out: true, updated_at: new Date().toISOString() }, { onConflict: 'wa_chat_id' });
                    continue;
                }

                // 2. Get/Create Contact
                let { data: contact } = await supabaseAdmin.from('contacts').select('*').eq('wa_chat_id', chatId).maybeSingle();
                const isNewContact = !contact;

                if (!contact) {
                    const { data: inserted } = await supabaseAdmin.from('contacts').insert({ wa_chat_id: chatId, stage: 'start' }).select('*').single();
                    contact = inserted;
                } else if (contact.opt_out) continue;

                if (!contact) continue;

                // 3. Store message
                await supabaseAdmin.from('messages').insert({
                    contact_id: contact.id,
                    direction: 'in',
                    provider_message_id: msg.key.id!,
                    text: userText
                });

                // 4. Load settings
                const { data: settingsRows } = await supabaseAdmin.from('settings').select('key, value');
                const settings: Record<string, string> = {};
                (settingsRows || []).forEach((row: any) => settings[row.key] = row.value);

                // 5. Build context & Call Gemini
                const { data: recentMsgs } = await supabaseAdmin
                    .from('messages')
                    .select('direction,text')
                    .eq('contact_id', contact.id)
                    .order('created_at', { ascending: true })
                    .limit(20);

                const memory = {
                    summary: contact.summary || '',
                    recent: (recentMsgs || []).map((m: any) => ({ direction: m.direction, text: m.text }))
                };

                const fullPrompt = [
                    settings['system_prompt'] || '',
                    settings['tone'] ? `\nТон общения: ${settings['tone']}` : '',
                    settings['site_url'] ? `\nОсновной сайт: ${settings['site_url']}` : '',
                    settings['candidate_link'] ? `\nСсылка для кандидата: ${settings['candidate_link']}` : '',
                    settings['agency_link'] ? `\nСсылка для агентства: ${settings['agency_link']}` : '',
                ].join('\n');

                console.log('🤖 [Baileys] Зовем Gemini...');
                const ai = await callGemini({ systemPrompt: fullPrompt, userText, memory, stage: contact.stage });

                let reply = normalizeText(ai.reply);
                if (!reply) reply = 'Понял тебя. Напиши, пожалуйста, из какой ты страны и какая работа интересует.';

                if (ai.need_link) {
                    const link = (ai.lead_type === 'agency' ? settings['agency_link'] : settings['candidate_link']) || settings['site_url'];
                    if (link) reply = `${reply}\n\nАнкета/регистрация: ${link}`;
                }

                // 6. Typing simulation
                await sock.presenceSubscribe(chatId);
                await sleep(randInt(1000, 3000));
                await sock.sendPresenceUpdate('composing', chatId);
                await sleep(randInt(2000, 4000));
                await sock.sendPresenceUpdate('paused', chatId);

                // 7. Send Reply
                await sock.sendMessage(chatId, { text: reply });
                console.log('✅ [Baileys] Ответ отправлен');

                // 8. Store outbound & update contact
                await supabaseAdmin.from('messages').insert({
                    contact_id: contact.id,
                    direction: 'out',
                    provider_message_id: `out:${msg.key.id}`,
                    text: reply
                });

                const nextStage = ai.next_stage || contact.stage;
                const newSummary = ai.memory_update ? ((contact.summary ? (contact.summary + '\n' + ai.memory_update) : ai.memory_update)) : contact.summary;

                await supabaseAdmin.from('contacts').update({
                    stage: nextStage,
                    summary: (newSummary || '').slice(0, 2000),
                    lead_type: ai.lead_type || 'unknown',
                    updated_at: new Date().toISOString()
                }).eq('id', contact.id);

                // 9. Admin notification for new contacts
                const adminPhone = settings['admin_phone'];
                if (isNewContact && adminPhone) {
                    try {
                        const senderName = chatId.split('@')[0];
                        const adminNotification = `🆕 Новый пользователь!\n\n📱 Номер: +${senderName}\n📝 Первое сообщение: "${userText}"`;
                        console.log('📤 [Baileys] Отправка уведомления админу:', adminPhone);
                        await sock.sendMessage(adminPhone + '@c.us', { text: adminNotification });
                    } catch (e: any) {
                        console.error('⚠️ [Baileys] Ошибка уведомления админа:', e.message);
                    }
                }

                // 10. Schedule follow-up
                const followupEnabled = settings['followup_enabled'] === 'true';
                const followupMessage = settings['followup_message'];
                const followupDelayHours = parseInt(settings['followup_delay_hours'] || '24');

                if (isNewContact && followupEnabled && followupMessage) {
                    try {
                        const scheduledAt = new Date(Date.now() + followupDelayHours * 60 * 60 * 1000);
                        await supabaseAdmin.from('scheduled_messages').insert({
                            contact_id: contact.id,
                            message_text: followupMessage,
                            scheduled_at: scheduledAt.toISOString(),
                        });
                        console.log(`📅 [Baileys] Запланирован фоллоу-ап для ${contact.id} на ${scheduledAt.toISOString()}`);
                    } catch (e: any) {
                        console.error('⚠️ [Baileys] Ошибка планирования фоллоу-апа:', e.message);
                    }
                }

            } catch (err) {
                console.error('❌ [Baileys] Ошибка при обработке сообщения:', err);
            }
        }
    });
    */
}
