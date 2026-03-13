const { GoogleGenerativeAI } = require('@google/generative-ai');

// Порядок: от самых стабильных к менее стабильным (по запросу пользователя)
const DEFAULT_MODELS = [
    'gemini-1.5-flash-latest',      // Основная, самая стабильная
    'gemini-1.5-flash-8b-latest',   // Быстрая замена
    'gemini-2.0-flash',             // Современная, высокая стабильность
    'gemini-1.5-pro-latest',        // Стабильная, но низкий лимит
    'gemini-2.5-flash-lite',        // Новая, быстрая (резерв)
    'gemini-2.5-flash'              // Мощная новинка (последний вариант)
]; let cachedWorkingModel = null;

async function callGemini(args) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error('❌ Missing GEMINI_API_KEY');
        return {
            reply: 'Произошла ошибка конфигурации AI. Пожалуйста, сообщите администратору.',
            next_stage: args.stage,
            lead_type: 'unknown'
        };
    }

    const envModel = process.env.GEMINI_MODEL;
    let models = envModel
        ? [envModel, ...DEFAULT_MODELS.filter(m => m !== envModel)]
        : DEFAULT_MODELS;

    if (cachedWorkingModel && !envModel) {
        models = [cachedWorkingModel, ...models.filter(m => m !== cachedWorkingModel)];
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    const recentLines = args.memory.recent
        .slice(-12)
        .map(m => (m.direction === 'in' ? `USER: ${m.text}` : `BOT: ${m.text}`))
        .join('\n');

    const prompt = [
        'Ты отвечаешь ТОЛЬКО валидным JSON.',
        'ВАЖНО: Ответ должен быть ТОЛЬКО JSON объектом, без markdown блоков (без ```json ... ```).',
        'Структура JSON: { "reply": "текст ответа", "next_stage": "название этапа", "lead_type": "unknown/candidate/agency", "need_link": false, "stop": false, "memory_update": "новая инфо" }',
        'Не повторяй вопросы, на которые уже есть ответы в MEMORY_SUMMARY.',
        'Если что-то непонятно - переспроси, но в поле reply.',
        '',
        'SYSTEM_PROMPT:',
        args.systemPrompt,
        '',
        'CURRENT_STAGE:',
        args.stage,
        '',
        'MEMORY_SUMMARY (информация о пользователе):',
        args.memory.summary || '(нет информации)',
        '',
        'RECENT_DIALOG (последние сообщения):',
        recentLines || '(диалог пуст)',
        '',
        'USER_MESSAGE (новое сообщение):',
        args.userText,
    ].join('\n');

    for (const modelName of models) {
        try {
            console.log(`🤖 [Gemini] Trying model: ${modelName}...`);
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(prompt);
            const raw = result.response.text().trim();

            const jsonText = extractJson(raw);
            const parsed = JSON.parse(jsonText);

            if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
                console.warn(`⚠️ [Gemini] Model ${modelName} returned invalid JSON, skipping...`);
                continue;
            }

            if (cachedWorkingModel !== modelName) {
                cachedWorkingModel = modelName;
                console.log(`✅ [Gemini] Cached working model: ${modelName}`);
            }

            return {
                reply: String(parsed.reply).slice(0, 500),
                next_stage: typeof parsed.next_stage === 'string' ? parsed.next_stage : undefined,
                lead_type: ['unknown', 'candidate', 'agency'].includes(parsed.lead_type) ? parsed.lead_type : 'unknown',
                need_link: typeof parsed.need_link === 'boolean' ? parsed.need_link : undefined,
                stop: typeof parsed.stop === 'boolean' ? parsed.stop : undefined,
                memory_update: typeof parsed.memory_update === 'string' ? parsed.memory_update.slice(0, 2000) : undefined,
            };

        } catch (e) {
            console.error(`❌ [Gemini] Model ${modelName} failed:`, e.message);
        }
    }

    console.error('❌CRITICAL [Gemini] All models failed.');
    console.error('❌CRITICAL [Gemini] All models failed.');
    const defaultFallback = `Извините, на данный момент все операторы заняты.

Вы обратились в Recruiter Club — это платформа, которая соединяет кандидатов напрямую с работодателями и проверенными агентствами. Чтобы попасть на конкретную вакансию, нужно зарегистрироваться и заполнить резюме. Работодатели рассматривают кандидатов только через анкеты внутри системы, в мессенджерах отбор не ведётся.

После регистрации вы находите нужную вакансию по стране, отправляете отклик напрямую работодателю, и если профиль подходит — с вами связывается живой менеджер Recruiter Club, который закреплён именно за этой вакансией и курирует данного работодателя.

Регистрация здесь: https://recruiterclub.online
При создании профиля выберите роль Candidate.

Приносим извинения за возможные неудобства.`;

    return {
        reply: args.fallbackMessage || defaultFallback,
        next_stage: args.stage, // Остаемся на том же этапе
        lead_type: 'unknown',
    };
}

function extractJson(s) {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first >= 0 && last > first) return s.slice(first, last + 1);
    return s;
}

module.exports = { callGemini };
