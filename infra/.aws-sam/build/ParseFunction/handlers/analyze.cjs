// backend/handlers/analyze.cjs
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const MODEL_ID = process.env.BEDROCK_MODEL_ID || 'amazon.nova-micro-v1:0';
const REGION = process.env.BEDROCK_REGION || 'us-east-1';

const client = new BedrockRuntimeClient({ region: REGION });

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const body = event.body
      ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body)
      : '{}';
    const { flags = [], nodes = [] } = JSON.parse(body);

    if (flags.length === 0 && nodes.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ summary: 'Nothing to analyze. Upload a template first.' }),
      };
    }

    const prompt = buildPrompt(nodes, flags);

        const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        schemaVersion: 'messages-v1',
        messages: [
          {
            role: 'user',
            content: [{ text: prompt }],
          },
        ],
        inferenceConfig: {
          maxTokens: 512,
          temperature: 0.3,
        },
      }),
    });

        const res = await client.send(command);
    const parsed = JSON.parse(new TextDecoder().decode(res.body));
    const summary = parsed.output?.message?.content?.[0]?.text?.trim() || 'No summary generated.';

    return { statusCode: 200, headers, body: JSON.stringify({ summary }) };
  } catch (err) {
    console.error('analyze error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Bedrock invocation failed' }),
    };
  }
};

function buildPrompt(nodes, flags) {
  const resourceList = nodes.map((n) => `- ${n.id} (${n.type})`).join('\n') || '(none)';
  const flagList =
    flags
      .map((f) => `- [${f.severity}] ${f.resourceId}: ${f.message}`)
      .join('\n') || '(none)';

  return `You are an infrastructure reviewer. You will be given a list of AWS resources and a list of pre-computed misconfiguration flags. The flags were detected deterministically by a rule engine — do NOT invent new flags, do NOT second-guess them, do NOT add generic security advice.

Your job is only to explain, in plain English, what this template deploys and why each flagged issue matters.

RESOURCES:
${resourceList}

FLAGS:
${flagList}

Write 2-4 short sentences. Start with a one-line description of what the template deploys. Then, for each flag, one sentence on what it is and why an engineer should care. Plain prose, no markdown, no bullet points, no headings.`;
}