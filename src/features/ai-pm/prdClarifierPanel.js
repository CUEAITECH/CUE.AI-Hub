/**
 * prdClarifierPanel.js — SPEC-L1 前端接线层。
 * 手风琴三步：描述想法 → 回答澄清 → PRD 预览/修改。
 * 数据只存模块私有变量，不进全局 state（单模块功能验证）。
 */
import { prdApi } from '../../api/prdApi.js';
import { collectAnswers, buildQuestionsHtml, buildPrdCardHtml } from './prdView.js';

let _bound = false;
let _input = '';
let _clarifyResult = null;
let _prd = null;

const $ = (id) => document.getElementById(id);

// ── 步骤展开/折叠状态机 ──────────────────────────────────────────
function setStep(n, status /* 'locked' | 'active' | 'done' */) {
  const step = $(`l1Step${n}`);
  const body = $(`l1Step${n}Body`);
  const statusEl = $(`l1Step${n}Status`);
  if (!step || !body) return;
  step.classList.remove('l1-step-locked', 'l1-step-active', 'l1-step-done');
  step.classList.add(`l1-step-${status}`);
  body.hidden = status === 'locked';
  if (statusEl) {
    statusEl.textContent = status === 'active' ? '当前步骤' : status === 'done' ? '已完成 · 点击回看' : statusEl.textContent;
  }
}

function showErr(n, msg) {
  const el = $(`l1Step${n}Err`);
  if (!el) return;
  if (msg) { el.textContent = msg; el.hidden = false; }
  else { el.textContent = ''; el.hidden = true; }
}

async function withBusy(btn, label, fn) {
  if (!btn) return fn();
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = orig; }
}

// ── Step 1 → clarify ─────────────────────────────────────────────
async function onClarify() {
  _input = ($('l1Input')?.value || '').trim();
  if (!_input) return;
  showErr(1, '');
  try {
    _clarifyResult = await withBusy($('l1ClarifyBtn'), '澄清中…', () => prdApi.clarify(_input));
    $('l1Questions').innerHTML = buildQuestionsHtml(_clarifyResult);
    setStep(1, 'done');
    setStep(2, 'active');
  } catch (e) {
    showErr(1, `澄清失败：${e.message}`);
  }
}

// ── Step 2 → generatePrd ─────────────────────────────────────────
async function onGenerate() {
  showErr(2, '');
  const questions = _clarifyResult?.clarificationQuestions || [];
  const values = Array.from(document.querySelectorAll('#l1Questions [data-qi]'))
    .sort((a, b) => Number(a.dataset.qi) - Number(b.dataset.qi))
    .map((el) => el.value);
  const answers = collectAnswers(questions, values);
  try {
    _prd = await withBusy($('l1GenerateBtn'), '生成中…', () => prdApi.generatePrd(_input, answers));
    $('l1PrdCard').innerHTML = buildPrdCardHtml(_prd);
    setStep(2, 'done');
    setStep(3, 'active');
  } catch (e) {
    showErr(2, `生成失败：${e.message}`);
  }
}

// ── Step 3 → refinePrd ───────────────────────────────────────────
async function onRefine() {
  showErr(3, '');
  const feedback = ($('l1Feedback')?.value || '').trim();
  if (!_prd?.id) return;
  if (!feedback) { showErr(3, '请先填写修改意见'); return; }
  try {
    _prd = await withBusy($('l1RefineBtn'), '修改中…', () => prdApi.refinePrd(_prd.id, feedback));
    $('l1PrdCard').innerHTML = buildPrdCardHtml(_prd);
    $('l1Feedback').value = '';
  } catch (e) {
    showErr(3, `修改失败：${e.message}`);
  }
}

// ── Tab 切换 ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.ai-pm-tab').forEach((b) => b.classList.toggle('active', b.dataset.aipmTab === name));
  const planning = $('aipmTabPlanning');
  const clarifier = $('aipmTabClarifier');
  if (planning) planning.hidden = name !== 'planning';
  if (clarifier) clarifier.hidden = name !== 'clarifier';
}

// ── 点击已完成步骤头 → 展开回看 ──────────────────────────────────
function onStepHeadClick(e) {
  const head = e.target.closest('.l1-step-head');
  if (!head) return;
  const step = head.closest('.l1-step');
  if (!step || !step.classList.contains('l1-step-done')) return;
  const body = step.querySelector('.l1-step-body');
  if (body) body.hidden = !body.hidden;
}

/** 初始化 L1 澄清面板。幂等：事件只绑定一次。 */
export function initPrdClarifierPanel() {
  if (_bound) return;
  if (!$('aipmTabClarifier')) return; // DOM 还没准备好就跳过
  _bound = true;

  $('aipmTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.ai-pm-tab');
    if (tab) switchTab(tab.dataset.aipmTab);
  });

  const input = $('l1Input');
  input?.addEventListener('input', () => {
    const btn = $('l1ClarifyBtn');
    if (btn) btn.disabled = !input.value.trim();
  });

  $('l1ClarifyBtn')?.addEventListener('click', onClarify);
  $('l1GenerateBtn')?.addEventListener('click', onGenerate);
  $('l1RefineBtn')?.addEventListener('click', onRefine);
  $('aipmTabClarifier')?.addEventListener('click', onStepHeadClick);
}
