

// CREDENTIALS (ENV or HARDCODED FALLBACK)
const supabaseUrl = process.env.SUPABASE_URL || 'https://zrctubjaqyyhtiumdtau.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const geminiKey = process.env.GEMINI_API_KEY || '';
const greenApiUrl = process.env.GREEN_API_BASE_URL || 'https://7105.api.greenapi.com';
const greenId = process.env.GREEN_API_ID_INSTANCE || '7105475055';
const greenToken = process.env.GREEN_API_TOKEN || 'b1a61afc4dce4282997b9a6ce386255a696b16ee244d4d36ac';


async function testSupabase() {
    console.log('\n--- Testing Supabase (REST) ---');
    try {
        const url = `${supabaseUrl}/rest/v1/contacts?select=count&limit=1`;
        const res = await fetch(url, {
            headers: {
                'apikey': supabaseKey,
                'Authorization': `Bearer ${supabaseKey}`
            }
        });

        if (res.ok) {
            console.log('✅ Supabase Connection: OK (Status ' + res.status + ')');
            return true;
        } else {
            console.error('❌ Supabase Error:', res.status, res.statusText);
            const text = await res.text();
            console.error('   Body:', text);
            return false;
        }
    } catch (e) {
        console.error('❌ Supabase Exception:', e.message);
        return false;
    }
}

async function testGeminiListModels() {
    console.log('\n--- Testing Gemini (List Models) ---');
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${geminiKey}`;
        const res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            console.log('✅ Gemini Models Found:', (data.models || []).length);
            const names = (data.models || []).map(m => m.name);
            console.log('   Available:', names.join(', '));
            if (names.includes('models/gemini-1.5-flash')) {
                console.log('   ✅ gemini-1.5-flash is available');
            } else {
                console.log('   ⚠️ gemini-1.5-flash is NOT in the list');
            }
            return true;
        } else {
            const text = await res.text();
            console.error('❌ Gemini ListModels Error:', res.status, text);
            return false;
        }
    } catch (e) {
        console.error('❌ Gemini Exception:', e.message);
        return false;
    }
}

async function checkGreenApiSettings() {
    console.log('\n--- Checking Green API Settings ---');
    const url = `${greenApiUrl}/waInstance${greenId}/getSettings/${greenToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data) {
            console.log('✅ Green API Settings Retrieved');
            console.log('   webhookUrl:', data.webhookUrl);
            console.log('   webhookUrlToken:', data.webhookUrlToken);
            console.log('   delaySendMessagesMilliseconds:', data.delaySendMessagesMilliseconds);
            console.log('   markIncomingMessagesReaded:', data.markIncomingMessagesReaded);
            console.log('   incomingWebhook:', data.incomingWebhook);
            return true;
        } else {
            console.error('❌ Green API Settings Empty');
            return false;
        }
    } catch (e) {
        console.error('❌ Green API Exception:', e.message);
        return false;
    }
}

async function run() {
    console.log('Starting Diagnostics...');
    await testSupabase();
    await checkGreenApiSettings();
    await testGeminiListModels();
    console.log('\nDone.');
}

run();
