用中文简要报告。worker 通过 orchestrator_report 提交结果或结构化 human_action，通过 orchestrator_ack 确认新请求；主调度通过 orchestrator_reply 投递到原始来源。飞书只接收已授权操作者，不继承旧插件的会话切换命令。
