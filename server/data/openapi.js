/**
 * CUE Project Hub OpenAPI 3.0 规范
 * 供企业微信 API 插件、Postman、Swagger UI 等使用
 */
export function buildOpenApiSpec(serverUrl) {
  const ref = (name) => ({ '$ref': `#/components/schemas/${name}` });
  const jsonBody = (schema) => ({ content: { 'application/json': { schema } } });
  const jsonResponse = (desc, schema) => ({
    [desc === '成功' ? '200' : desc === '创建成功' ? '201' : '200']: {
      description: desc,
      content: { 'application/json': { schema } }
    }
  });

  return {
    openapi: '3.0.3',
    info: {
      title: 'CUE Project Hub API',
      description: [
        'AI 研发项目指挥系统接口文档。',
        '机器人可通过这些接口查询项目状态、提交站会、创建/更新任务、生成 AI 日报和汇总站会。',
        '所有 POST 请求均使用 JSON 请求体，所有响应均为 JSON。'
      ].join(' '),
      version: '0.2.0'
    },
    servers: [{ url: serverUrl, description: 'CUE Project Hub 服务器' }],
    paths: {
      '/api/state': {
        get: {
          operationId: 'getProjectState',
          summary: '获取项目整体状态',
          description: '返回健康度评分、所有任务、成员负载、风险告警、最近 AI 审阅和项目指标。用于回答"今天项目整体状态怎么样"、"有多少风险任务"等问题。',
          responses: {
            '200': {
              description: '项目状态',
              content: { 'application/json': { schema: {
                type: 'object',
                properties: {
                  tasks: { type: 'array', description: '所有任务列表' },
                  members: { type: 'array', description: '团队成员列表' },
                  alerts: { type: 'array', description: '风险告警列表' },
                  metrics: {
                    type: 'object',
                    description: '项目健康指标',
                    properties: {
                      healthScore: { type: 'number', description: '健康度评分 0-100' },
                      highRiskTasks: { type: 'number' },
                      pendingReviews: { type: 'number' },
                      urgentAlerts: { type: 'number' }
                    }
                  }
                }
              }}}
            }
          }
        }
      },

      '/api/tasks': {
        get: {
          operationId: 'listTasks',
          summary: '获取任务列表',
          description: '返回任务列表。可用 status 参数过滤：待确认、进行中、高风险、已完成。用于"现在有哪些任务在推进"、"高风险任务有哪些"等问题。',
          parameters: [{
            name: 'status', in: 'query', required: false,
            description: '按状态过滤，可选值：待确认、进行中、待拆分、高风险、已完成',
            schema: { type: 'string' }
          }],
          responses: {
            '200': { description: '任务列表', content: { 'application/json': { schema: {
              type: 'object',
              properties: { tasks: { type: 'array', items: ref('Task') } }
            }}}}
          }
        },
        post: {
          operationId: 'createTask',
          summary: '创建新任务',
          description: '创建一个新研发任务。用于"帮我创建一个任务：XX，负责人：YY，截止日期：ZZ"。',
          requestBody: { required: true, ...jsonBody(ref('TaskInput')) },
          responses: {
            '201': { description: '创建成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: { task: ref('Task') }
            }}}}
          }
        }
      },

      '/api/tasks/{id}': {
        patch: {
          operationId: 'updateTask',
          summary: '更新任务',
          description: '更新任务的状态、进度、负责人等字段。用于"把任务 XX 的进度更新为 80%"、"把任务 YY 标记为已完成"。需要先通过 listTasks 获取任务 ID。',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: '任务 ID（形如 task_xxx）' }],
          requestBody: { required: true, ...jsonBody(ref('TaskInput')) },
          responses: {
            '200': { description: '更新成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: { task: ref('Task') }
            }}}},
            '404': { description: '任务不存在' }
          }
        },
        delete: {
          operationId: 'deleteTask',
          summary: '删除任务',
          description: '删除指定任务。需要先通过 listTasks 获取任务 ID。',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '200': { description: '删除成功' } }
        }
      },

      '/api/members': {
        get: {
          operationId: 'listMembers',
          summary: '获取团队成员列表',
          description: '返回所有团队成员及其负载、角色、响应时间。用于"团队成员现在谁最忙"、"有哪些成员"。',
          responses: {
            '200': { description: '成员列表', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                members: { type: 'array', items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    role: { type: 'string' },
                    focus: { type: 'string', description: '专长领域' },
                    load: { type: 'number', description: '负载百分比 0-100' },
                    response: { type: 'string', description: '平均响应时间' }
                  }
                }}
              }
            }}}}
          }
        }
      },

      '/api/standups': {
        get: {
          operationId: 'getStandups',
          summary: '获取今日站会记录',
          description: '返回今天已提交站会的成员和内容。用于"今天谁还没填站会"、"查看今天的站会记录"。',
          parameters: [{
            name: 'date', in: 'query', required: false,
            schema: { type: 'string', format: 'date' },
            description: '查询日期 YYYY-MM-DD，默认今天'
          }],
          responses: {
            '200': { description: '站会记录', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                standups: { type: 'array', items: ref('Standup') }
              }
            }}}}
          }
        },
        post: {
          operationId: 'submitStandup',
          summary: '提交站会',
          description: '提交今日站会，包含昨日完成、今日计划、阻塞项。当用户说"我昨天完成了XX，今天计划做YY，没有阻塞"时，解析内容并调用此接口代为提交。',
          requestBody: { required: true, ...jsonBody(ref('StandupInput')) },
          responses: {
            '201': { description: '提交成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                standup: ref('Standup'),
                count: { type: 'number', description: '今日已提交人数' }
              }
            }}}}
          }
        }
      },

      '/api/standups/summarize': {
        post: {
          operationId: 'summarizeStandups',
          summary: 'AI 汇总今日站会',
          description: '用 AI 汇总今天所有成员的站会，生成结构化日站摘要，包含阻塞项和请假信息。用于"帮我汇总一下今天的站会"。',
          requestBody: { required: false, ...jsonBody({ type: 'object' }) },
          responses: {
            '200': { description: '站会汇总', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                summary: { type: 'string', description: 'AI 生成的站会摘要（Markdown）' },
                standups: { type: 'array' }
              }
            }}}}
          }
        }
      },

      '/api/risks/scan': {
        post: {
          operationId: 'scanRisks',
          summary: '扫描风险并获取告警',
          description: '扫描所有任务和审阅记录，返回风险告警（延期、无进展、阻断 Review 等）。用于"今天有什么风险"、"有哪些紧急问题"。',
          requestBody: { required: false, ...jsonBody({ type: 'object' }) },
          responses: {
            '200': { description: '风险告警', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                alerts: { type: 'array', items: ref('Alert') },
                metrics: { type: 'object' }
              }
            }}}}
          }
        }
      },

      '/api/reports/daily': {
        post: {
          operationId: 'generateDailyReport',
          summary: '生成 AI 研发日报',
          description: 'AI 根据今日任务进展、代码审阅、站会记录、风险告警生成结构化日报，适合发给管理者。用于"帮我生成今天的日报"、"生成研发日报"。',
          requestBody: { required: false, ...jsonBody({ type: 'object' }) },
          responses: {
            '200': { description: '日报内容', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                date: { type: 'string' },
                report: { type: 'string', description: 'AI 生成的日报（Markdown）' },
                wecomSent: { type: 'boolean', description: '是否已推送至企业微信' }
              }
            }}}}
          }
        }
      },

      '/api/plans': {
        post: {
          operationId: 'generatePlan',
          summary: '根据阶段目标 AI 生成任务计划',
          description: '输入阶段目标（自然语言），AI 自动拆解为 3-6 个具体任务并分配负责人。用于"帮我把下周的目标拆成任务"。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['goal'],
              properties: { goal: { type: 'string', description: '阶段目标描述，例如：5月底完成用户认证和支付模块' } }
            }}}
          },
          responses: {
            '200': { description: '生成的任务列表', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                goal: { type: 'string' },
                tasks: { type: 'array', items: ref('Task') }
              }
            }}}}
          }
        }
      }
    },

    components: {
      schemas: {
        Task: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '任务 ID，形如 task_xxx' },
            title: { type: 'string', description: '任务标题' },
            owner: { type: 'string', description: '负责人姓名' },
            status: { type: 'string', enum: ['待确认', '进行中', '待拆分', '高风险', '已完成'] },
            due: { type: 'string', format: 'date', description: '截止日期' },
            risk: { type: 'string', enum: ['低', '中', '高'] },
            progress: { type: 'number', minimum: 0, maximum: 100, description: '进度百分比' },
            signal: { type: 'string', description: '最新进展信号' },
            acceptance: { type: 'string', description: '验收标准' }
          }
        },
        TaskInput: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            owner: { type: 'string', description: '负责人，默认"未分配"' },
            due: { type: 'string', format: 'date' },
            status: { type: 'string', enum: ['待确认', '进行中', '待拆分', '高风险', '已完成'] },
            risk: { type: 'string', enum: ['低', '中', '高'] },
            progress: { type: 'number', minimum: 0, maximum: 100 },
            acceptance: { type: 'string' },
            signal: { type: 'string' }
          }
        },
        Standup: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            date: { type: 'string', format: 'date' },
            owner: { type: 'string', description: '提交人姓名' },
            yesterday: { type: 'string', description: '昨日完成内容' },
            today: { type: 'string', description: '今日计划' },
            blockers: { type: 'string', description: '阻塞项' },
            isLeave: { type: 'boolean', description: '是否请假' },
            proxy: { type: 'string', description: '请假交接人' },
            createdAt: { type: 'string', format: 'date-time' }
          }
        },
        StandupInput: {
          type: 'object',
          required: ['owner'],
          properties: {
            owner: { type: 'string', description: '提交站会的成员姓名，需是团队成员之一' },
            yesterday: { type: 'string', description: '昨天完成了什么' },
            today: { type: 'string', description: '今天计划做什么' },
            blockers: { type: 'string', description: '阻塞项，没有填"无"' },
            isLeave: { type: 'boolean', description: '是否今日请假' },
            proxy: { type: 'string', description: '请假时的交接人姓名' }
          }
        },
        Alert: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['P1', 'P2', 'P3'], description: 'P1 最紧急' },
            title: { type: 'string' },
            detail: { type: 'string' },
            target: { type: 'string', description: '需要处理的人' }
          }
        }
      }
    }
  };
}
