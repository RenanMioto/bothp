// register.js (opcional)
import 'dotenv/config';
import { REST, Routes } from 'discord.js';

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;
if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Faltam variáveis no .env');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const commands = [
  { name: 'analise', description: 'Abrir pedido de análise (passo a passo).' },
];

try {
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ /analise registrado.');
} catch (e) {
  console.error('Erro ao registrar comandos:', e);
}
