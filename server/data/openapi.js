/**
 * CUE Project Hub OpenAPI 3.0 规范
 * 供企业微信 API 插件、Postman、Swagger UI 等使用
 */
export function buildOpenApiSpec(serverUrl) {
  const ref = (name) => ({ '$ref': `#/components/schemas/${name}` });
  const jsonBody = (schema) => ({ content: { 'application/json': { schema } } });
  const apiKeySecurity = [{ CueApiKey: [] }];
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
          parameters: [{
            name: 'projectId', in: 'query', required: false,
            description: '项目 ID；不传时使用默认项目。',
            schema: { type: 'string' }
          }],
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

      '/api/stage/checklist': {
        get: {
          operationId: 'getStageChecklist',
          summary: '获取开发阶段对照清单',
          description: '返回当前阶段目标清单，以及每一项与任务、Git 提交、AI Review、分工领取的对照结果。用于"当前分工是否对应阶段目标"、"阶段还有哪些缺口"。',
          parameters: [{
            name: 'projectId', in: 'query', required: false,
            description: '项目 ID；用于切换查看不同项目的阶段清单。',
            schema: { type: 'string' }
          }],
          responses: {
            '200': { description: '阶段对照清单', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                stage: { type: 'object', description: '当前阶段信息' },
                checklist: { type: 'array', description: '阶段目标对照项' },
                metrics: { type: 'object', description: '完成、阻塞、缺证据统计' }
              }
            }}}}
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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

      '/api/wecom/tasks': {
        get: {
          operationId: 'getTaskList',
          summary: '获取当前可认领任务列表',
          description: '返回当前进行中、待确认的任务列表，适合在企业微信中展示让成员选择认领。用于"现在有哪些任务"、"今天可以认领什么任务"。',
          parameters: [{
            name: 'projectId', in: 'query', required: false,
            description: '项目 ID；不传时使用默认项目。',
            schema: { type: 'string' }
          }],
          responses: {
            '200': { description: '任务列表', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                tasks: { type: 'array', description: '可认领任务列表', items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    owner: { type: 'string' },
                    status: { type: 'string' },
                    progress: { type: 'number' }
                  }
                }},
                projectId: { type: 'string', description: '本次查询使用的项目 ID' },
                summary: { type: 'string', description: '可直接回复给用户的任务列表摘要' },
                result: { type: 'string', description: '同 summary，兼容企业微信字段配置' }
              }
            }}}}
          }
        }
      },

      '/api/wecom/claim': {
        post: {
          operationId: 'claimTaskByKeyword',
          summary: '按关键词认领任务',
          description: '成员通过任务关键词认领任务，无需知道任务 ID。用于"我认领XX任务"、"我今天负责YY"。系统会模糊匹配任务标题并自动生成任务细则。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['owner', 'keyword'],
              properties: {
                owner: { type: 'string', description: '认领人姓名，需是团队成员之一：田家铭、胡佳涛、罗子宽、林世棋' },
                projectId: { type: 'string', description: '项目 ID；不传时使用默认项目' },
                keyword: { type: 'string', description: '任务标题关键词，系统自动模糊匹配' },
                taskKeyword: { type: 'string', description: '同 keyword，兼容企业微信字段配置' },
                note: { type: 'string', description: '今日工作计划说明（可选）' }
              }
            }}}
          },
          responses: {
            '201': { description: '认领成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                result: { type: 'string', description: '可直接回复给用户的认领结果摘要' },
                assignment: { type: 'object', description: '认领记录' }
              }
            }}}},
            '400': { description: '未找到匹配任务或已认领' }
          }
        }
      },

      '/api/wecom/standup': {
        post: {
          operationId: 'submitStandupViaWecom',
          summary: '企业微信内提交站会',
          description: '成员在企业微信中直接提交站会。用于"我昨天完成了XX，今天计划YY，没有阻塞"这类自然语言输入。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['owner'],
              properties: {
                owner: { type: 'string', description: '提交人姓名，需是团队成员之一：田家铭、胡佳涛、罗子宽、林世棋' },
                projectId: { type: 'string', description: '项目 ID；不传时使用默认项目' },
                yesterday: { type: 'string', description: '昨天完成了什么' },
                today: { type: 'string', description: '今天计划做什么' },
                blockers: { type: 'string', description: '阻塞项，没有填"无"' },
                isLeave: { type: 'boolean', description: '是否今日请假' }
              }
            }}}
          },
          responses: {
            '201': { description: '提交成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                result: { type: 'string', description: '可直接回复给用户的提交确认' }
              }
            }}}}
          }
        }
      },

      '/api/wecom/attendance': {
        post: {
          operationId: 'recordAttendanceViaWecom',
          summary: '企业微信内记录考勤反馈',
          description: '把企业微信成员回复写入考勤统计。支持"姓名正常完成"、"姓名延迟完成"、"姓名正常出席"、"姓名延迟出席"、"姓名临时请假"、"姓名缺勤"；消息前带 @机器人 或 <@bot> 也会自动忽略。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string', description: '成员原始回复文本，例如：林世棋正常出席；也兼容 content / message 字段。' },
                content: { type: 'string', description: '同 text，兼容企业微信字段配置。' },
                message: { type: 'string', description: '同 text，兼容企业微信字段配置。' },
                projectId: { type: 'string', description: '项目 ID；不传时使用默认项目。' },
                date: { type: 'string', description: '考勤日期 YYYY-MM-DD；不传时使用当天。' }
              }
            }}}
          },
          responses: {
            '200': { description: '记录结果', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                result: { type: 'string', description: '可直接回复给成员的记录结果。' },
                projectId: { type: 'string', description: '记录所属项目 ID。' },
                record: { type: 'object', description: '写入的考勤记录。' }
              }
            }}}}
          }
        }
      },

      '/api/wecom/command': {
        post: {
          operationId: 'handleWeComDeterministicCommand',
          summary: '企业微信模块化指令入口',
          description: '不调用大语言模型，直接按固定指令返回结果或写入考勤。适合配置成智能机器人按钮/快捷指令：菜单、每日排名、每周排名、晚会统计、任务完成统计、今日考勤，以及"姓名正常完成/姓名正常出席"等考勤回复。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['text'],
              properties: {
                text: { type: 'string', description: '成员原始指令，例如：每日排名、晚会统计、林世棋正常出席。也兼容 content / message 字段。' },
                content: { type: 'string', description: '同 text，兼容企业微信字段配置。' },
                message: { type: 'string', description: '同 text，兼容企业微信字段配置。' },
                projectId: { type: 'string', description: '项目 ID；不传时使用默认项目。' },
                date: { type: 'string', description: '查询/记录日期 YYYY-MM-DD；不传时使用当天。' },
                push: { type: 'boolean', description: '是否把结果再通过 webhook 推送到群里。' }
              }
            }}}
          },
          responses: {
            '200': { description: '指令结果', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                type: { type: 'string', description: '命中的指令类型。' },
                result: { type: 'string', description: '可直接回复给成员的中文结果。' },
                summary: { type: 'string', description: '同 result，部分接口兼容字段。' },
                record: { type: 'object', description: '考勤写入时返回的记录。' },
                records: { type: 'array', description: '统计类指令命中的记录列表。' },
                missing: { type: 'array', description: '统计类指令中尚未记录的成员/事项。' }
              }
            }}}}
          }
        }
      },

      '/api/wecom/progress': {
        post: {
          operationId: 'updateTaskProgressByKeyword',
          summary: '按关键词更新任务进度',
          description: '成员通过任务关键词更新进度百分比。用于"把XX任务进度更新为80%"、"YY任务已完成"。',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object',
              required: ['keyword', 'progress'],
              properties: {
                keyword: { type: 'string', description: '任务标题关键词，系统自动模糊匹配' },
                projectId: { type: 'string', description: '项目 ID；不传时使用默认项目' },
                progress: { type: 'number', minimum: 0, maximum: 100, description: '进度百分比，0-100' },
                signal: { type: 'string', description: '进展说明（可选）' }
              }
            }}}
          },
          responses: {
            '200': { description: '更新成功', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                result: { type: 'string', description: '可直接回复给用户的更新确认' }
              }
            }}}},
            '404': { description: '未找到匹配任务' }
          }
        }
      },

      '/api/wecom/summary': {
        get: {
          operationId: 'getWeComProjectSummary',
          summary: '获取企业微信项目摘要',
          description: '返回一段适合企业微信机器人直接回复的项目状态摘要。用于"现在项目进展怎么样"、"晚会前先给我项目概况"。输出参数只需配置 summary 为 String。',
          parameters: [{
            name: 'projectId', in: 'query', required: false,
            description: '项目 ID；不传时使用默认项目。',
            schema: { type: 'string' }
          }],
          responses: {
            '200': { description: '项目摘要', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: '可直接回复给用户的中文项目状态摘要' },
                projectId: { type: 'string', description: '本次摘要对应的项目 ID' },
                alertCount: { type: 'number', description: '当前告警数量' },
                generatedAt: { type: 'string', format: 'date-time', description: '生成时间' },
                metrics: { type: 'object', description: '项目健康指标' }
              }
            }}}}
          }
        }
      },

      '/api/wecom/risks': {
        get: {
          operationId: 'getWeComRiskSummary',
          summary: '获取企业微信风险摘要',
          description: '返回一段适合企业微信机器人直接回复的风险摘要。用于"今天有哪些风险"、"晚会要先处理什么"。输出参数只需配置 summary 为 String。',
          parameters: [{
            name: 'projectId', in: 'query', required: false,
            description: '项目 ID；不传时使用默认项目。',
            schema: { type: 'string' }
          }],
          responses: {
            '200': { description: '风险摘要', content: { 'application/json': { schema: {
              type: 'object',
              properties: {
                summary: { type: 'string', description: '可直接回复给用户的中文风险摘要' },
                alertCount: { type: 'number', description: '当前告警数量' },
                generatedAt: { type: 'string', format: 'date-time', description: '生成时间' },
                metrics: { type: 'object', description: '项目健康指标' }
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
          security: apiKeySecurity,
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
          security: apiKeySecurity,
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
      },

      '/api/assignments': {
        get: {
          operationId: 'getAssignments',
          summary: '获取今日分工领取情况',
          description: '查看今天谁领取了哪些任务，包含进度状态。用于"今天大家分别在做什么"、"我今天领了哪些任务"。',
          parameters: [{ name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
          responses: { '200': { description: '分工列表' } }
        },
        post: {
          operationId: 'claimTask',
          summary: '领取今日分工任务',
          description: '成员领取一个任务作为今日分工。用于"我今天认领XX任务"、"我负责YY"。',
          security: apiKeySecurity,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['owner', 'taskId'], properties: { owner: { type: 'string' }, taskId: { type: 'string' }, note: { type: 'string' } } } } } },
          responses: { '201': { description: '领取成功' } }
        }
      },

      '/api/reports/evening': {
        post: {
          operationId: 'generateEveningReport',
          summary: '生成今日晚报（含 commit 汇总）',
          description: '汇总今日 GitHub 提交、任务分工完成情况，生成结构化晚报。用于"生成今天的晚报"、"帮我总结一下今天的工作"。',
          security: apiKeySecurity,
          responses: { '200': { description: '晚报内容' } }
        },
        get: {
          operationId: 'getEveningReport',
          summary: '获取指定日期晚报',
          description: '查看已生成的晚报内容。用于"看一下昨天的晚报"。',
          parameters: [{ name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
          responses: { '200': { description: '晚报' } }
        }
      },

      '/api/reports/compare': {
        get: {
          operationId: 'compareReport',
          summary: '对照总结：晚报分工 vs 实际 commits',
          description: '将昨日晚报中的任务分工与实际 commit 记录进行对照，生成完成/遗漏分析。用于"对比一下昨天的计划和实际完成"、"谁的任务有遗漏"。',
          parameters: [{ name: 'date', in: 'query', required: false, schema: { type: 'string', format: 'date' } }],
          responses: { '200': { description: '对照分析' } }
        }
      },

      '/api/plan-adjustments': {
        get: {
          operationId: 'getPlanAdjustments',
          summary: '获取 AI 计划调整建议',
          description: '查看根据最新 GitHub 提交自动生成的计划调整建议。major 进入人工审批；minor/progress 自动执行并写回阶段短名、进度或路径节点。',
          responses: {
            '200': {
              description: '调整建议列表',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      adjustments: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/PlanAdjustment' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/api/plan-adjustments/{id}/decision': {
        post: {
          operationId: 'decidePlanAdjustment',
          summary: '审批 AI PM 大计划调整',
          description: '人工批准或拒绝 major 级开发计划调整。批准后写回 currentStage.shortName、阶段状态、进度和路径节点。',
          security: apiKeySecurity,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['decision'],
                  properties: {
                    decision: { type: 'string', enum: ['approved', 'rejected'] },
                    note: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: { '200': { description: '审批结果' } }
        }
      }
    },

    components: {
      securitySchemes: {
        CueApiKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-CUE-API-Key',
          description: '公网写接口鉴权密钥。服务器配置 CUE_API_KEY 后，POST/PATCH/DELETE /api/* 需要传入该请求头。'
        }
      },
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
        },
        PlanStageUpdate: {
          type: 'object',
          properties: {
            shortName: { type: 'string', description: '总览短名，中文最多14字或英文最多20字符' },
            status: { type: 'string', enum: ['进行中', '高风险', '阻塞', '已完成'] },
            progressDelta: { type: 'number', minimum: -30, maximum: 30 },
            checklist: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  owner: { type: 'string' },
                  keywords: { type: 'array', items: { type: 'string' } },
                  acceptance: { type: 'string' }
                }
              }
            }
          }
        },
        PlanAdjustment: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            scope: { type: 'string', enum: ['minor', 'major', 'progress'] },
            mode: { type: 'string', enum: ['approval', 'auto'] },
            status: { type: 'string', enum: ['pending_approval', 'auto_applied', 'approved', 'rejected'] },
            summary: { type: 'string' },
            suggestion: { type: 'string' },
            impact: { type: 'string' },
            requiresApprovalReason: { type: 'string' },
            stageUpdate: { $ref: '#/components/schemas/PlanStageUpdate' },
            trigger: { type: 'string' },
            triggerCount: { type: 'number' },
            source: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            appliedAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  };
}
