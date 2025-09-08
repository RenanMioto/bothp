
# Bot de Pedidos de Análise — Fluxo Passo a Passo (Wizard)

Este bot guia o piloto por **3 telas (modals)** após o comando `/analise`:
1. **Passo 1**: Requerido (quem está sendo citado).
2. **Passo 2**: Link do vídeo + Parágrafo do regulamento.
3. **Passo 3**: Tipo de dano + Argumento.
> O **Requerente** é detectado automaticamente (quem executa o comando).

No final, o bot publica um **embed** no canal configurado (`PEDIDOS_CHANNEL_ID`) e:
- Se o canal for **Fórum**, cria um **Post**;
- Se for **Texto**, envia a mensagem e abre uma **Thread** para a discussão.

## Requisitos
- Node.js 18+
- App/Bot no Discord com escopos `bot` e `applications.commands`

## Instalação
```bash
npm install
cp .env.example .env  # edite com seus IDs e token
npm start
```

## Variáveis (.env)
- `DISCORD_TOKEN` — token do bot
- `CLIENT_ID` — ID do aplicativo
- `GUILD_ID` — ID do servidor
- `PEDIDOS_CHANNEL_ID` — ID do canal de destino (Fórum ou Texto)
- `EMBED_COLOR` — (opcional) cor do embed em hex

## Observações
- O bot mantém uma **sessão em memória** por usuário durante o wizard (expira em ~15 min). Se expirar, inicie o `/analise` de novo.
- Se usar canal Fórum, gerencie **tags** (Ex.: Em análise, Procedente, Improcedente etc.) pelo próprio Discord.
- O campo "info" no Passo 1 é apenas informativo: o Requerente sempre será quem executou o comando.
