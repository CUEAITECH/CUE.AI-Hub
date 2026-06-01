import { getTenantId } from '../services/auth.js';
export function createStandupRoutes({
  loadStore,
  updateStore,
  readBody,
  sendJson,
  sendError,
  normalizeStandup,
  todayText,
  callClaude,
  isWeComAvailable,
  sendWeComMarkdown
}) {
  const getDateParam = (url) => url.searchParams.get('date') || todayText();

  return async function standupRoutes(req, res, url) {
    if (req.method === 'GET' && url.pathname === '/api/standups') {
      const store = await loadStore(getTenantId(req));
      const date = getDateParam(url);
      sendJson(res, 200, {
        date,
        standups: (store.standups || []).filter((standup) => standup.date === date)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/standups') {
      const { json } = await readBody(req);
      const standup = normalizeStandup(json || {});
      if (!standup.owner) {
        sendError(res, 400, 'owner is required');
        return true;
      }

      const nextStore = await updateStore((draft) => {
        const existingIndex = (draft.standups || []).findIndex((item) => (
          item.date === standup.date && item.owner === standup.owner
        ));
        if (existingIndex >= 0) {
          draft.standups[existingIndex] = {
            ...draft.standups[existingIndex],
            ...standup,
            id: draft.standups[existingIndex].id,
            createdAt: draft.standups[existingIndex].createdAt
          };
        } else {
          draft.standups = [standup, ...(draft.standups || [])].slice(0, 500);
        }
        return draft;
      }, getTenantId(req));
      sendJson(res, 201, {
        standup,
        standups: (nextStore.standups || []).filter((item) => item.date === standup.date)
      });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/standups/summarize') {
      const store = await loadStore(getTenantId(req));
      const today = todayText();
      const todayStandups = (store.standups || []).filter((standup) => standup.date === today);
      if (!todayStandups.length) {
        sendJson(res, 200, { date: today, summary: '今日暂无站会记录。', standups: [] });
        return true;
      }

      const systemPrompt = `你是 CUE Project Hub 的异步站会 AI 主持人。
根据团队成员提交的站会记录，生成一份简洁的中文日站总结，格式要求：
1. 开头一句话概括整体状态（人数、阻塞数量）
2. 按成员列出：昨日完成、今日计划、阻塞项（如有）
3. 单独列出请假成员和交接人
4. 末尾列出需要管理者关注的阻塞项（如有）
输出纯文本 Markdown，不需要 JSON。`;

      const userPrompt = `今天是 ${today}，以下是各成员的站会回复：\n\n${todayStandups.map((standup) => `**${standup.owner}**${standup.isLeave ? '（请假，交接人：' + (standup.proxy || '未指定') + '）' : ''}
- 昨日：${standup.yesterday || '未填写'}
- 今日：${standup.today || '未填写'}
- 阻塞：${standup.blockers || '无'}`).join('\n\n')}`;

      const summary = await callClaude(systemPrompt, userPrompt) ||
        todayStandups.map((standup) => `${standup.owner}：${standup.today || '未填写今日计划'}`).join('；');

      await updateStore((draft) => {
        draft.standupSummaries = draft.standupSummaries || {};
        draft.standupSummaries[today] = { summary, generatedAt: new Date().toISOString() };
        return draft;
      }, getTenantId(req));

      if (isWeComAvailable()) {
        await sendWeComMarkdown(`# ${today} 站会汇总\n\n${summary}`);
      }

      sendJson(res, 200, { date: today, summary, standups: todayStandups });
      return true;
    }

    return false;
  };
}
