// index.js — Bot de Análises (discord.js v14)
// Fluxo: Pedido → Tópico → Defesa → Julgamento (Comissão) com tags no Fórum
// Respostas ephemeral e 1-resposta-por-interação garantidas.

import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';

const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  PEDIDOS_CHANNEL_ID,
  EMBED_COLOR,
  COMISSAO_ROLE_ID,
  DIRETORIA_ROLE_ID,
  LOG_CHANNEL_ID, // opcional
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID || !PEDIDOS_CHANNEL_ID) {
  console.error('❌ .env incompleto (DISCORD_TOKEN, CLIENT_ID, GUILD_ID, PEDIDOS_CHANNEL_ID).');
  process.exit(1);
}

/* =============== Registro do /analise =============== */
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  const commands = [{ name: 'analise', description: 'Abrir pedido de análise.' }];
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log('✅ Slash command /analise registrado.');
}

/* ===================== Utils ===================== */
const colorInt = () => (EMBED_COLOR ? parseInt(EMBED_COLOR.replace('#', ''), 16) : undefined);
// Se quiser filtrar anexos por tipo/MIME, ajuste esta função:
const isEvidenceAttachment = () => true;

function hasStaffPerm(member) {
  return Boolean(
    member?.roles?.cache?.has(COMISSAO_ROLE_ID) ||
    member?.roles?.cache?.has(DIRETORIA_ROLE_ID) ||
    member?.permissions?.has(PermissionFlagsBits.ManageThreads) ||
    member?.permissions?.has(PermissionFlagsBits.ManageMessages)
  );
}

function findForumTagIdByName(availableTags, targetNames) {
  if (!Array.isArray(availableTags) || availableTags.length === 0) return null;
  const norm = s => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  const wanted = targetNames.map(norm);
  for (const t of availableTags) {
    const name = norm(t.name);
    if (wanted.some(w => name.includes(w))) return t.id;
  }
  return null;
}

/* ================= Sessões e guardião ================= */
const defenseSessions = new Map();      // userId -> { threadId, exp }
const evidenceSessions = new Map();     // userId -> { kind:'pedido'|'defesa'|'avaliacao', threadId, exp }
const allowedByThread = new Map();      // threadId -> { userIds:Set, roleIds:Set }
const analisePick = new Map();          // userId -> { requeridoId, exp }

function buildAllowedSet({ comissaoRoleId, diretoriaRoleId, requerenteId, requeridoId }) {
  return {
    userIds: new Set([requerenteId, requeridoId].filter(Boolean)),
    roleIds: new Set([comissaoRoleId, diretoriaRoleId].filter(Boolean)),
  };
}

/* ====================== Bot ====================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, () => {
  console.log(`🚀 Logado como ${client.user.tag}`);
});

/* Guardião e coletor de anexos */
client.on(Events.MessageCreate, async (msg) => {
  // Guardião de quem pode falar
  const allow = allowedByThread.get(msg.channel.id);
  if (allow && !msg.author.bot) {
    const member = msg.member;
    const isAllowedUser = allow.userIds.has(msg.author.id);
    const isAllowedRole = member?.roles?.cache?.some(r => allow.roleIds.has(r.id));
    const isStaff = hasStaffPerm(member);
    if (!isAllowedUser && !isAllowedRole && !isStaff) {
      try { await msg.delete(); } catch {}
      try { await msg.author.send(`⚠️ Sua mensagem em **${msg.channel.name}** foi removida: apenas envolvidos e Comissão/Diretoria podem responder neste tópico.`); } catch {}
      return;
    }
  }

  // Coletor de anexos para sessões em aberto
  const sess = evidenceSessions.get(msg.author.id);
  if (!sess) return;
  if (sess.exp < Date.now()) { evidenceSessions.delete(msg.author.id); return; }
  if (msg.channel.id !== sess.threadId) return;
  if (msg.attachments.size === 0) return;

  const atts = [...msg.attachments.values()].filter(isEvidenceAttachment);
  if (atts.length === 0) return;

  const emb = new EmbedBuilder()
    .setTitle(
      sess.kind === 'pedido' ? '📎 Vídeo anexado (pedido)' :
      sess.kind === 'defesa' ? '📎 Vídeo anexado (defesa)' :
                               '🗂️ Evidência anexada (comissão)'
    )
    .setDescription(atts.map(a => `• [Arquivo](${a.url})`).join('\n'))
    .setTimestamp();
  const c = colorInt(); if (c !== undefined) emb.setColor(c);

  await msg.channel.send({ embeds: [emb] });
  evidenceSessions.delete(msg.author.id);
});

/* ================= Interações ================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    /* -------- /analise -------- */
    if (interaction.isChatInputCommand() && interaction.commandName === 'analise') {
      const select = new UserSelectMenuBuilder()
        .setCustomId('pick_requerido')
        .setPlaceholder('Selecione o piloto requerido…')
        .setMinValues(1)
        .setMaxValues(1);

      const row = new ActionRowBuilder().addComponents(select);
      return interaction.reply({
        content: '👤 Escolha **quem será o Requerido**. Depois abrirei o formulário.',
        components: [row],
        ephemeral: true,
      });
    }

    /* ---- seletor do Requerido → abre modal do pedido ---- */
    if (interaction.isUserSelectMenu?.() && interaction.customId === 'pick_requerido') {
      const [requeridoId] = interaction.values || [];
      if (!requeridoId) {
        return interaction.reply({ content: '⚠️ Selecione um piloto.', ephemeral: true });
      }

      analisePick.set(interaction.user.id, { requeridoId, exp: Date.now() + 10 * 60 * 1000 });

      const modal = new ModalBuilder().setCustomId('analise_modal').setTitle('Pedido de Análise');
      const linkVideo = new TextInputBuilder().setCustomId('linkVideo').setLabel('Link do vídeo (opcional)').setStyle(TextInputStyle.Short).setRequired(false);
      const tipoDano  = new TextInputBuilder().setCustomId('tipoDano').setLabel('Tipo de dano').setStyle(TextInputStyle.Short).setRequired(true);
      const argumento = new TextInputBuilder().setCustomId('argumento').setLabel('Argumento (explique o lance)').setStyle(TextInputStyle.Paragraph).setRequired(true);

      modal.addComponents(
        new ActionRowBuilder().addComponents(linkVideo),
        new ActionRowBuilder().addComponents(tipoDano),
        new ActionRowBuilder().addComponents(argumento),
      );

      await interaction.showModal(modal);
      return; // única resposta desta interação
    }

    /* ---- submissão do pedido ---- */
    if (interaction.isModalSubmit() && interaction.customId === 'analise_modal') {
      const pick = analisePick.get(interaction.user.id);
      if (!pick || pick.exp < Date.now()) {
        return interaction.reply({ content: '⚠️ Sua seleção do **Requerido** expirou. Use **/analise** novamente.', ephemeral: true });
      }

      const requerente = interaction.user;
      const requeridoUser = await interaction.client.users.fetch(pick.requeridoId).catch(() => null);
      const mentionRequerido = requeridoUser ? `<@${requeridoUser.id}>` : null;

      const linkVideo = (interaction.fields.getTextInputValue('linkVideo') || '').trim();
      const tipoDano  = interaction.fields.getTextInputValue('tipoDano').trim();
      const argumento = interaction.fields.getTextInputValue('argumento').trim();

      if (linkVideo && !/^https?:\/\/\S+$/i.test(linkVideo)) {
        return interaction.reply({ content: '🔗 Link inválido. Use http(s) ou deixe vazio e anexe o vídeo.', ephemeral: true });
      }

      const requerenteName = interaction.member?.displayName || interaction.user.username;
      const requeridoName  = requeridoUser?.username || 'Desconhecido';
      const threadName = `analise ${requerenteName} vs ${requeridoName}`.slice(0, 90);

      const embed = new EmbedBuilder()
        .setTitle('📋 Pedido de Análise')
        .addFields(
          { name: 'Requerente', value: `${requerente}`, inline: false },
          { name: 'Requerido',  value: mentionRequerido || requeridoName, inline: false },
          ...(linkVideo ? [{ name: 'Link do vídeo', value: linkVideo, inline: false }] : []),
          { name: 'Tipo de dano', value: tipoDano, inline: true },
          { name: 'Argumento',   value: argumento.slice(0, 1024), inline: false },
        )
        .setFooter({ text: 'Status: Em análise' })
        .setTimestamp();
      const c1 = colorInt(); if (c1 !== undefined) embed.setColor(c1);

      // botões públicos do tópico
      const btnDefesa = new ButtonBuilder().setCustomId(`defesa_btn:${requeridoUser ? requeridoUser.id : 'any'}`).setLabel('Enviar defesa').setStyle(ButtonStyle.Primary);
      const btnAnexarPedido = new ButtonBuilder().setCustomId(`attach_pedido:${interaction.user.id}`).setLabel('Anexar vídeo (pedido)').setStyle(ButtonStyle.Secondary);
      const btnPainelComissao = new ButtonBuilder().setCustomId('panel_comissao').setLabel('Painel da Comissão').setStyle(ButtonStyle.Secondary);
      const rowPublic = new ActionRowBuilder().addComponents(btnDefesa, btnAnexarPedido, btnPainelComissao);

      // controlar menções
      const mentions = [];
      if (mentionRequerido) mentions.push(mentionRequerido);
      if (COMISSAO_ROLE_ID) mentions.push(`<@&${COMISSAO_ROLE_ID}>`);
      if (DIRETORIA_ROLE_ID) mentions.push(`<@&${DIRETORIA_ROLE_ID}>`);
      const allowedMentions = {
        users: mentionRequerido ? [requeridoUser.id] : [],
        roles: [COMISSAO_ROLE_ID, DIRETORIA_ROLE_ID].filter(Boolean),
        repliedUser: false,
        parse: [], // evita @everyone/here
      };

      try {
        const target = await interaction.client.channels.fetch(PEDIDOS_CHANNEL_ID);
        if (!target) throw new Error(`Canal não encontrado: ${PEDIDOS_CHANNEL_ID}`);

        if (target.type === ChannelType.GuildForum) {
          const tags = target.availableTags || [];
          const tagInicial = findForumTagIdByName(tags, ['em analise', 'em análise', 'analise']) || null;

          const post = await target.threads.create({
            name: threadName,
            message: { content: mentions.join(' '), embeds: [embed], components: [rowPublic], allowedMentions },
            appliedTags: tagInicial ? [tagInicial] : [],
            reason: 'Novo pedido de análise',
          });

          allowedByThread.set(post.id, buildAllowedSet({
            comissaoRoleId: COMISSAO_ROLE_ID,
            diretoriaRoleId: DIRETORIA_ROLE_ID,
            requerenteId: interaction.user.id,
            requeridoId: requeridoUser?.id || null,
          }));

          if (!linkVideo) {
            await post.send(`📎 ${requerente}, anexe o **vídeo do pedido** aqui no tópico (ou use o botão **Anexar vídeo (pedido)**).`);
          }
          if (requeridoUser) { try { await requeridoUser.send(`📣 Você foi mencionado em um **pedido de análise** por ${requerente}.\n🔗 ${post.url}`); } catch {} }

          if (LOG_CHANNEL_ID) {
            try { const logCh = await interaction.client.channels.fetch(LOG_CHANNEL_ID); await logCh.send(`📣 Novo pedido de análise: ${post.url}`); } catch {}
          }

          analisePick.delete(interaction.user.id);
          return interaction.reply({ content: `✅ Pedido enviado em ${post.toString()}`, ephemeral: true });
        }

        // alternativa: canal de texto + thread
        if (target.type === ChannelType.GuildText) {
          const msg = await target.send({ content: mentions.join(' '), embeds: [embed], components: [rowPublic], allowedMentions });
          const thread = await msg.startThread({ name: threadName, autoArchiveDuration: 1440, reason: 'Discussão de análise' });

          allowedByThread.set(thread.id, buildAllowedSet({
            comissaoRoleId: COMISSAO_ROLE_ID,
            diretoriaRoleId: DIRETORIA_ROLE_ID,
            requerenteId: interaction.user.id,
            requeridoId: requeridoUser?.id || null,
          }));

          if (!linkVideo) {
            await thread.send(`📎 ${requerente}, anexe o **vídeo do pedido** aqui no tópico (ou use o botão **Anexar vídeo (pedido)**).`);
          }
          if (requeridoUser) { try { await requeridoUser.send(`📣 Você foi mencionado em um **pedido de análise** por ${requerente}.\n🔗 ${thread.url}`); } catch {} }

          if (LOG_CHANNEL_ID) {
            try { const logCh = await interaction.client.channels.fetch(LOG_CHANNEL_ID); await logCh.send(`📣 Novo pedido de análise: ${thread.url}`); } catch {}
          }

          analisePick.delete(interaction.user.id);
          return interaction.reply({ content: `✅ Pedido enviado. Discussão: ${thread.toString()}`, ephemeral: true });
        }

      } catch (e) {
        console.error('Falha ao publicar:', e?.message || e);
        return interaction.reply({ content: '❌ Erro ao publicar. Verifique canal/permissões.', ephemeral: true });
      }
    }

    /* ----------- Botões ----------- */
    if (interaction.isButton()) {
      // Painel da Comissão
      if (interaction.customId === 'panel_comissao') {
        if (!hasStaffPerm(interaction.member)) {
          return interaction.reply({ content: '❌ Apenas Comissão/Diretoria têm acesso ao painel.', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use dentro do tópico da análise.', ephemeral: true });
        }

        const bCulpado  = new ButtonBuilder().setCustomId('eval_culpado').setLabel('Culpado').setStyle(ButtonStyle.Danger);
        const bInocente = new ButtonBuilder().setCustomId('eval_inocente').setLabel('Inocente').setStyle(ButtonStyle.Success);
        const bIndefer  = new ButtonBuilder().setCustomId('eval_indeferido').setLabel('Indeferido').setStyle(ButtonStyle.Secondary);
        const bAttach   = new ButtonBuilder().setCustomId('attach_avaliacao').setLabel('Anexar evidências').setStyle(ButtonStyle.Secondary);

        const rowA = new ActionRowBuilder().addComponents(bCulpado, bInocente, bIndefer);
        const rowB = new ActionRowBuilder().addComponents(bAttach);

        return interaction.reply({
          content: '🛠️ **Painel da Comissão** — escolha o resultado ou anexe evidências.',
          components: [rowA, rowB],
          ephemeral: true,
        });
      }

      // Julgamento: abre modal (correção do "interação falhou")
      if (interaction.customId === 'eval_culpado' || interaction.customId === 'eval_inocente' || interaction.customId === 'eval_indeferido') {
        if (!hasStaffPerm(interaction.member)) {
          return interaction.reply({ content: '❌ Apenas Comissão/Diretoria podem julgar.', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use os botões **dentro do tópico** da análise.', ephemeral: true });
        }

        const resultado =
          interaction.customId === 'eval_culpado'   ? 'Procedente' :
          interaction.customId === 'eval_inocente'  ? 'Improcedente' :
                                                      'Indeferido';

        const modal = new ModalBuilder()
          .setCustomId(`avaliacao_modal:${resultado}`)
          .setTitle(`Julgamento — ${resultado}`);

        const parag = new TextInputBuilder()
          .setCustomId('avaliacao_parag')
          .setLabel('Parágrafo do regulamento (ex.: 14.5)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const puni = new TextInputBuilder()
          .setCustomId('avaliacao_punicao')
          .setLabel('Punição (ex.: +5s, advertência...)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const arg = new TextInputBuilder()
          .setCustomId('avaliacao_arg')
          .setLabel('Argumento da comissão')
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(parag),
          new ActionRowBuilder().addComponents(puni),
          new ActionRowBuilder().addComponents(arg),
        );

        await interaction.showModal(modal);
        return; // única resposta desta interação
      }

      // Anexos (pedido/defesa/avaliacao)
      if (interaction.customId.startsWith('attach_pedido:')) {
        const [, reqId] = interaction.customId.split(':');
        if (interaction.user.id !== reqId && !hasStaffPerm(interaction.member)) {
          return interaction.reply({ content: '❌ Só o **requerente** (ou staff) pode anexar o vídeo do pedido.', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use o botão **dentro do tópico** da análise.', ephemeral: true });
        }
        evidenceSessions.set(interaction.user.id, { kind: 'pedido', threadId: interaction.channel.id, exp: Date.now() + 2 * 60 * 1000 });
        return interaction.reply({ content: '📥 Envie o **arquivo de vídeo** aqui em até **2 minutos**.', ephemeral: true });
      }

      if (interaction.customId === 'attach_avaliacao') {
        if (!hasStaffPerm(interaction.member)) {
          return interaction.reply({ content: '❌ Apenas Comissão/Diretoria podem anexar evidências.', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use o botão **dentro do tópico**.', ephemeral: true });
        }
        evidenceSessions.set(interaction.user.id, { kind: 'avaliacao', threadId: interaction.channel.id, exp: Date.now() + 2 * 60 * 1000 });
        return interaction.reply({ content: '📥 Envie a(s) **imagem(ns)/arquivo(s)** aqui em até **2 minutos**.', ephemeral: true });
      }

      if (interaction.customId.startsWith('attach_defesa:')) {
        const [, reqdId] = interaction.customId.split(':');
        if (interaction.user.id !== reqdId && !hasStaffPerm(interaction.member)) {
          return interaction.reply({ content: '❌ Só o **requerido** (ou staff) pode anexar o vídeo da defesa.', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use o botão **dentro do tópico**.', ephemeral: true });
        }
        evidenceSessions.set(interaction.user.id, { kind: 'defesa', threadId: interaction.channel.id, exp: Date.now() + 2 * 60 * 1000 });
        return interaction.reply({ content: '📥 Envie o **arquivo de vídeo da defesa** aqui em até **2 minutos**.', ephemeral: true });
      }

      // Enviar defesa → abre modal
      if (interaction.customId.startsWith('defesa_btn:')) {
        const [, alvoId] = interaction.customId.split(':');
        const isMod = hasStaffPerm(interaction.member);
        if (alvoId !== 'any' && interaction.user.id !== alvoId && !isMod) {
          return interaction.reply({ content: '❌ Este botão é apenas para o **requerido** (ou moderadores).', ephemeral: true });
        }
        if (!interaction.channel?.isThread?.()) {
          return interaction.reply({ content: '⚠️ Use o botão **dentro do tópico**.', ephemeral: true });
        }

        defenseSessions.set(interaction.user.id, { threadId: interaction.channel.id, exp: Date.now() + 30 * 60 * 1000 });

        const modal = new ModalBuilder().setCustomId('defesa_modal').setTitle('Defesa do Requerido');
        const link = new TextInputBuilder().setCustomId('defesa_link').setLabel('Link do vídeo (opcional)').setStyle(TextInputStyle.Short).setRequired(false);
        const arg  = new TextInputBuilder().setCustomId('defesa_arg').setLabel('Argumento da defesa').setStyle(TextInputStyle.Paragraph).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(link), new ActionRowBuilder().addComponents(arg));

        await interaction.showModal(modal);
        return;
      }
    }

    /* ---- submissão da DEFESA ---- */
    if (interaction.isModalSubmit() && interaction.customId === 'defesa_modal') {
      const sess = defenseSessions.get(interaction.user.id);
      if (!sess || (sess.exp && sess.exp < Date.now())) {
        return interaction.reply({ content: '⚠️ Sessão expirada. Use o botão novamente.', ephemeral: true });
      }
      const link = (interaction.fields.getTextInputValue('defesa_link') || '').trim();
      const arg  = interaction.fields.getTextInputValue('defesa_arg').trim();
      if (link && !/^https?:\/\/\S+$/i.test(link)) {
        return interaction.reply({ content: '🔗 Link inválido. Use http(s) ou anexe depois.', ephemeral: true });
      }

      const defense = new EmbedBuilder()
        .setTitle('🛡️ Defesa do Requerido')
        .addFields(
          { name: 'Requerido', value: `${interaction.user}`, inline: false },
          ...(link ? [{ name: 'Link do vídeo (defesa)', value: link, inline: false }] : []),
          { name: 'Argumento (defesa)', value: arg.slice(0, 1024), inline: false },
        )
        .setTimestamp();
      const c3 = colorInt(); if (c3 !== undefined) defense.setColor(c3);

      try {
        const thread = await interaction.client.channels.fetch(sess.threadId);
        if (!link) {
          const btnAttachDef = new ButtonBuilder().setCustomId(`attach_defesa:${interaction.user.id}`).setLabel('Anexar vídeo (defesa)').setStyle(ButtonStyle.Secondary);
          const row = new ActionRowBuilder().addComponents(btnAttachDef);
          await thread.send({ embeds: [defense], components: [row] });
        } else {
          await thread.send({ embeds: [defense] });
        }
        await interaction.reply({ content: '✅ Defesa enviada.', ephemeral: true });
      } catch (e) {
        console.error('Falha ao postar defesa:', e?.message || e);
        await interaction.reply({ content: '❌ Não consegui postar a defesa.', ephemeral: true });
      } finally {
        defenseSessions.delete(interaction.user.id);
      }
      return;
    }

    /* ---- submissão do JULGAMENTO (Comissão) ---- */
    if (interaction.isModalSubmit() && interaction.customId.startsWith('avaliacao_modal:')) {
      const resultado = interaction.customId.split(':')[1]; // Procedente/Improcedente/Indeferido
      const paragrafo = interaction.fields.getTextInputValue('avaliacao_parag').trim();
      const punicao   = interaction.fields.getTextInputValue('avaliacao_punicao').trim();
      const argumento = interaction.fields.getTextInputValue('avaliacao_arg').trim();

      const emb = new EmbedBuilder()
        .setAuthor({ name: 'Comissão' }) // não expõe quem julgou
        .setTitle(`📑 Julgamento — ${resultado}`)
        .addFields(
          { name: 'Parágrafo do regulamento', value: paragrafo.slice(0, 256), inline: false },
          { name: 'Punição', value: punicao.slice(0, 256), inline: false },
          { name: 'Argumento', value: argumento.slice(0, 1024), inline: false },
        )
        .setTimestamp();
      const c4 = colorInt(); if (c4 !== undefined) emb.setColor(c4);

      // botão para anexar evidências extras
      const btnAttach = new ButtonBuilder().setCustomId('attach_avaliacao').setLabel('Anexar evidências').setStyle(ButtonStyle.Secondary);
      const row = new ActionRowBuilder().addComponents(btnAttach);

      try {
        const thread = interaction.channel?.isThread?.()
          ? interaction.channel
          : await interaction.client.channels.fetch(interaction.channelId);

        await thread.send({ embeds: [emb], components: [row] });

        // troca de TAG no fórum
        if (thread.type === ChannelType.PublicThread && thread.parent?.type === ChannelType.GuildForum) {
          const tags = thread.parent.availableTags || [];
          const tagId =
            resultado === 'Procedente'   ? findForumTagIdByName(tags, ['procedente', 'verde']) :
            resultado === 'Improcedente' ? findForumTagIdByName(tags, ['improcedente', 'azul']) :
                                            findForumTagIdByName(tags, ['indeferido', 'branco']);
          if (tagId) {
            try { await thread.edit({ appliedTags: [tagId] }); } catch (e) {
              console.warn('⚠️ Não foi possível alterar tag do fórum:', e?.message || e);
            }
          }
        }

        await interaction.reply({ content: '✅ Decisão registrada pela **Comissão**.', ephemeral: true });

        if (LOG_CHANNEL_ID) {
          try {
            const ch = await client.channels.fetch(LOG_CHANNEL_ID);
            await ch.send(`🕵️ Decisão **${resultado}** por ${interaction.user.tag} — Parágrafo: ${paragrafo} — Punição: ${punicao}`);
          } catch {}
        }
      } catch (e) {
        console.error('Falha ao registrar julgamento:', e?.message || e);
        await interaction.reply({ content: '❌ Não consegui registrar o julgamento.', ephemeral: true });
      }
      return;
    }
  } catch (err) {
    console.error(err);
    try { await interaction.reply({ content: 'Ocorreu um erro ao processar.', ephemeral: true }); } catch {}
  }
});

/* ===================== Boot ===================== */
registerCommands()
  .then(() => client.login(DISCORD_TOKEN))
  .catch((e) => { console.error('❌ Falha ao registrar comandos:', e); process.exit(1); });
