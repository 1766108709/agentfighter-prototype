import { createAgentApiServer } from "./server/agent-api-server.mjs";

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const application = await createAgentApiServer({
  dataDir: process.env.AGENTFIGHTER_DATA_DIR,
  publicBaseUrl: process.env.AGENTFIGHTER_PUBLIC_URL,
});
const listening = await application.listen({ port, host });

process.stdout.write(`AgentFighter game + Agent API running at ${listening.url}\n`);
process.stdout.write("Local reference sandbox enabled; use an OS/container sandbox before public multi-tenant hosting.\n");
