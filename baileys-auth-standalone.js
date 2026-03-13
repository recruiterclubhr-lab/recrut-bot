// Supabase auth state for Baileys - standalone version
const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');

async function useSupabaseAuthState(sessionId, supabase) {
    const writeData = async (data, id) => {
        const { error } = await supabase
            .from('wa_sessions')
            .upsert({ id: `${sessionId}:${id}`, data: JSON.parse(JSON.stringify(data, BufferJSON.replacer)) });
        if (error) console.error('❌ [SupabaseAuth] Save Error:', error);
    };

    const readData = async (id) => {
        const { data, error } = await supabase
            .from('wa_sessions')
            .select('data')
            .eq('id', `${sessionId}:${id}`)
            .maybeSingle();

        if (error) {
            console.error('❌ [SupabaseAuth] Read Error:', error);
            return null;
        }
        return data ? JSON.parse(JSON.stringify(data.data), BufferJSON.reviver) : null;
    };

    const removeData = async (id) => {
        await supabase.from('wa_sessions').delete().eq('id', `${sessionId}:${id}`);
    };

    const creds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = JSON.parse(JSON.stringify(value), BufferJSON.reviver);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds'),
    };
}

module.exports = { useSupabaseAuthState };
