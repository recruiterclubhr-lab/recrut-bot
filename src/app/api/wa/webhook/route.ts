import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/db';
import { callGemini } from '@/lib/server/gemini';
import { greenSendMessage } from '@/lib/server/greenapi';
import { hasOptOut, normalizeText } from '@/lib/server/util';
import { randInt, sleep } from '@/lib/server/util';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.warn(`⚠️ Missing environment variable: ${name}`);
    return '';
  }
  return v;
}

function getSecretFromReq(req: Request): string | null {
  const url = new URL(req.url);
  return req.headers.get('x-webhook-secret') || url.searchParams.get('secret');
}


function parseGreenWebhook(body: any): { chatId: string; messageId: string; text: string } | null {
  const chatId =
    body?.senderData?.chatId ||
    body?.chatId ||
    body?.chatID ||
    body?.data?.chatId;

  const messageId =
    body?.idMessage ||
    body?.messageId ||
    body?.id ||
    body?.data?.idMessage ||
    body?.senderData?.idMessage;

  const text =
    body?.messageData?.textMessageData?.textMessage ||
    body?.messageData?.extendedTextMessageData?.text ||
    body?.messageData?.quotedMessage?.textMessageData?.textMessage ||
    body?.text ||
    body?.data?.text;

  if (!chatId || !messageId || !text) return null;
  return { chatId: String(chatId), messageId: String(messageId), text: String(text) };
}




export async function POST(req: Request) {
  console.log('📬 [Webhook] Request received at:', new Date().toISOString());

  try {
    const body = await req.json().catch((e) => {
      console.error('❌ [Webhook] JSON Parse Error:', e);
      return null;
    });

    console.log('📦 [Webhook] Body:', JSON.stringify(body, null, 2));

    if (!body) return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });

    const parsed = parseGreenWebhook(body);
    if (!parsed) {
      console.log('ℹ️ [Webhook] Ignored - Not a text message or invalid structure');
      return NextResponse.json({ ok: true, ignored: true });
    }

    // 1. Check Webhook Type
    const typeWebhook = body.typeWebhook;
    if (typeWebhook !== 'incomingMessageReceived') {
      console.log(`ℹ️ [Webhook] Ignored non-message type: ${typeWebhook}`);
      return NextResponse.json({ ok: true, ignored: true });
    }

    // 2. Check Sender (Ignore Self)
    const senderData = body.senderData || {};
    const senderId = senderData.sender;
    const instanceData = body.instanceData || {};
    const myWid = instanceData.wid;

    if (senderId === myWid) {
      console.log('ℹ️ [Webhook] Ignored own message');
      return NextResponse.json({ ok: true, ignored: true });
    }

    console.log('✅ [Webhook] Parsed:', parsed);
    const chatId = parsed.chatId;
    const providerMessageId = parsed.messageId;
    const userText = normalizeText(parsed.text);

    // opt-out
    if (hasOptOut(userText)) {
      await supabaseAdmin.from('contacts').upsert({ wa_chat_id: chatId, opt_out: true, updated_at: new Date().toISOString() }, { onConflict: 'wa_chat_id' });
      return NextResponse.json({ ok: true, opted_out: true });
    }

    // upsert contact
    const { data: contactRow, error: contactError } = await supabaseAdmin
      .from('contacts')
      .select('id, stage, summary, lead_type, opt_out')
      .eq('wa_chat_id', chatId)
      .maybeSingle();

    if (contactError) {
      console.error('❌ [Webhook] Contact Fetch Error:', contactError);
      // Continue? Or return error? Let's return error to see it.
      return NextResponse.json({ ok: false, error: contactError.message }, { status: 500 });
    }

    let contact = contactRow;
    const isNewContact = !contact;
    if (!contact) {
      const { data: inserted, error } = await supabaseAdmin
        .from('contacts')
        .insert({ wa_chat_id: chatId, stage: 'start', lead_type: 'unknown', summary: '', opt_out: false })
        .select('id, stage, summary, lead_type, opt_out')
        .single();
      if (error) {
        console.error('❌ [Webhook] Contact Insert Error:', error);
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      contact = inserted;
    } else if (contact.opt_out) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    const contactId = contact.id;


    // dedup: try insert inbound message unique by provider_message_id
    // CHECK FIRST if message already exists to avoid processing loop
    const { data: existingMsg } = await supabaseAdmin
      .from('messages')
      .select('id')
      .eq('provider_message_id', providerMessageId)
      .maybeSingle();

    if (existingMsg) {
      console.log('ℹ️ [Webhook] Duplicate message found (pre-check), ignoring:', providerMessageId);
      return NextResponse.json({ ok: true, dedup: true });
    }

    const { error: inErr } = await supabaseAdmin.from('messages').insert({
      contact_id: contactId,
      direction: 'in',
      provider_message_id: providerMessageId,
      text: userText,
    });

    if (inErr) {
      // if duplicate, just ignore
      if (String(inErr.message || '').toLowerCase().includes('duplicate')) {
        console.log('ℹ️ [Webhook] Duplicate message ignored (insert-time)');
        return NextResponse.json({ ok: true, dedup: true });
      }
      console.error('⚠️ [Webhook] Message Insert Error:', inErr);
      // other errors still proceed cautiously
    }

    // load settings in one batch to reduce RTT (critical for Vercel timeout)
    const { data: settingsRows, error: settingsError } = await supabaseAdmin
      .from('settings')
      .select('key, value')
      .in('key', ['system_prompt', 'site_url', 'candidate_link', 'agency_link', 'tone', 'admin_phone', 'followup_enabled', 'followup_delay_hours', 'followup_message']);

    if (settingsError) {
      console.error('❌ [Webhook] Settings Fetch Error:', settingsError);
    }

    const settings: Record<string, string> = {};
    (settingsRows || []).forEach((row: any) => settings[row.key] = row.value);


    const systemPrompt = settings['system_prompt'] || '';
    const siteUrl = settings['site_url'] || '';
    const candidateLink = settings['candidate_link'] || '';
    const agencyLink = settings['agency_link'] || '';
    const tone = settings['tone'] || '';
    const adminPhone = settings['admin_phone'] || '';
    const followupEnabled = settings['followup_enabled'] === 'true';
    const followupDelayHours = parseInt(settings['followup_delay_hours'] || '24');
    const followupMessage = settings['followup_message'] || '';


    const stage = contact.stage || 'start';
    const summary = contact.summary || '';


    const { data: recentMsgs } = await supabaseAdmin
      .from('messages')
      .select('direction,text')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(30);

    const memory = { summary, recent: (recentMsgs || []).map((m: any) => ({ direction: m.direction, text: m.text })) };


    const fullPrompt = [
      systemPrompt || '',
      tone ? `\nТон общения: ${tone}` : '',
      siteUrl ? `\nОсновной сайт: ${siteUrl}` : '',
      candidateLink ? `\nСсылка для кандидата: ${candidateLink}` : '',
      agencyLink ? `\nСсылка для агентства: ${agencyLink}` : '',
    ].join('\n');

    console.log('🤖 [Webhook] Calling Gemini...');
    const ai = await callGemini({ systemPrompt: fullPrompt, userText, memory, stage });
    console.log('🤖 [Webhook] Gemini Reply:', ai.reply);

    let reply = normalizeText(ai.reply);
    if (!reply) reply = 'Понял. Напиши, пожалуйста: страна и какая работа интересует.';

    // If need_link, append correct link (simple heuristic)
    if (ai.need_link) {
      const link = (ai.lead_type === 'agency' ? agencyLink : candidateLink) || siteUrl;
      if (link) reply = `${reply}\n\nАнкета/регистрация: ${link}`;
    }

    // random human delay (reduced for Vercel 10s timeout)
    const delay = randInt(1000, 3000); // Updated to 3s max for safety
    console.log(`⏳ [Webhook] Sleeping ${delay}ms...`);
    await sleep(delay);


    // send message
    try {
      console.log('📤 [Webhook] Sending to GreenAPI...');
      await greenSendMessage(chatId, reply);
      console.log('✅ [Webhook] Message sent successfully');
    } catch (e: any) {
      console.error('❌ [Webhook] GreenAPI Send Failure:', e);
      return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
    }

    // store outbound
    const { error: outErr } = await supabaseAdmin.from('messages').insert({
      contact_id: contactId,
      direction: 'out',
      provider_message_id: `out:${providerMessageId}`,
      text: reply,
    });
    if (outErr) console.error('⚠️ [Webhook] Outbound Message Save Error:', outErr);

    // update contact stage and summary
    const nextStage = ai.next_stage || stage;
    const newSummary = ai.memory_update ? (summary ? (summary + '\n' + ai.memory_update) : ai.memory_update) : summary;

    await supabaseAdmin.from('contacts').update({
      stage: nextStage,
      summary: newSummary.slice(0, 2000),
      lead_type: ai.lead_type || 'unknown',
      updated_at: new Date().toISOString(),
    }).eq('id', contactId);

    // Send admin notification for new contacts
    if (isNewContact && adminPhone) {
      try {
        const senderName = parsed.chatId.split('@')[0];
        const adminNotification = `🆕 Новый пользователь!\n\n📱 Номер: +${senderName}\n📝 Первое сообщение: "${userText}"`;
        console.log('📤 [Webhook] Sending admin notification to:', adminPhone);
        await greenSendMessage(adminPhone + '@c.us', adminNotification);
      } catch (e: any) {
        console.error('⚠️ [Webhook] Admin notification failed:', e.message);
      }
    }

    // Schedule follow-up message for new contacts
    if (isNewContact && followupEnabled && followupMessage) {
      try {
        const scheduledAt = new Date(Date.now() + followupDelayHours * 60 * 60 * 1000);
        await supabaseAdmin.from('scheduled_messages').insert({
          contact_id: contactId,
          message_text: followupMessage,
          scheduled_at: scheduledAt.toISOString(),
        });
        console.log(`📅 [Webhook] Scheduled follow-up for contact ${contactId} at ${scheduledAt.toISOString()}`);
      } catch (e: any) {
        console.error('⚠️ [Webhook] Follow-up scheduling failed:', e.message);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('❌CRITICAL [Webhook] Uncaught Exception:', err);
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}
