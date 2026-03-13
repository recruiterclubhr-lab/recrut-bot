import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/server/db';
import { greenSendMessage } from '@/lib/server/greenapi';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        console.log('📤 [Scheduler] Checking for pending scheduled messages...');

        // Get all pending messages that are due
        const { data: pendingMessages, error: fetchError } = await supabaseAdmin
            .from('scheduled_messages')
            .select('id, contact_id, message_text')
            .eq('status', 'pending')
            .lte('scheduled_at', new Date().toISOString())
            .limit(50);

        if (fetchError) {
            console.error('❌ [Scheduler] Fetch Error:', fetchError);
            return NextResponse.json({ error: fetchError.message }, { status: 500 });
        }

        if (!pendingMessages || pendingMessages.length === 0) {
            console.log('ℹ️ [Scheduler] No pending messages');
            return NextResponse.json({ sent: 0 });
        }

        console.log(`📤 [Scheduler] Found ${pendingMessages.length} messages to send`);

        let sentCount = 0;
        let failedCount = 0;

        for (const msg of pendingMessages) {
            try {
                // Get contact's wa_chat_id
                const { data: contact } = await supabaseAdmin
                    .from('contacts')
                    .select('wa_chat_id')
                    .eq('id', msg.contact_id)
                    .single();

                if (!contact) {
                    console.warn(`⚠️ [Scheduler] Contact ${msg.contact_id} not found, marking as failed`);
                    await supabaseAdmin
                        .from('scheduled_messages')
                        .update({ status: 'failed', sent_at: new Date().toISOString() })
                        .eq('id', msg.id);
                    failedCount++;
                    continue;
                }

                // Send message
                console.log(`📤 [Scheduler] Sending message ${msg.id} to ${contact.wa_chat_id}`);
                await greenSendMessage(contact.wa_chat_id, msg.message_text);

                // Mark as sent
                await supabaseAdmin
                    .from('scheduled_messages')
                    .update({ status: 'sent', sent_at: new Date().toISOString() })
                    .eq('id', msg.id);

                sentCount++;
                console.log(`✅ [Scheduler] Sent message ${msg.id}`);
            } catch (e: any) {
                console.error(`❌ [Scheduler] Failed to send message ${msg.id}:`, e.message);
                await supabaseAdmin
                    .from('scheduled_messages')
                    .update({ status: 'failed', sent_at: new Date().toISOString() })
                    .eq('id', msg.id);
                failedCount++;
            }
        }

        console.log(`✅ [Scheduler] Completed: ${sentCount} sent, ${failedCount} failed`);
        return NextResponse.json({ sent: sentCount, failed: failedCount });
    } catch (err: any) {
        console.error('❌CRITICAL [Scheduler] Uncaught Exception:', err);
        return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
    }
}
