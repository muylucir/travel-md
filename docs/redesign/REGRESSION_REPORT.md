# Graph RAG Redesign — Regression Report

- 케이스: 1 / 검사 항목: 1
- ✅ 통과: 0 (0.0%)
- ❌ 실패: 1

- Runtime: `ota_travel_agent-fjp2B62iQc`
- 평균 latency: 39.2s

## C4_nara_solo_winter — 나라·2박·혼자힐링·겨울

- Latency: **39.2s** · 통과 0 / 실패 1
- Error: `ResourceNotFoundException("An error occurred (ResourceNotFoundException) when calling the InvokeAgentRuntime operation: No endpoint or agent found with qualifier 'DEFAULT' for agent 'arn:aws:bedrock-agentcore:ap-northeast-2:939105814298:runtime/ota_travel_agent-fjp2B62iQc'")`

| 검사 | 결과 | 상세 |
|---|:-:|---|
| Runtime invoke 성공 | ❌ | ResourceNotFoundException("An error occurred (ResourceNotFoundException) when calling the InvokeAgentRuntime operation: No endpoint or agent found with qualifier 'DEFAULT' for agent 'arn:aws:bedrock-agentcore:ap-northeast-2:939105814298:runtime/ota_travel_agent-fjp2B62iQc'") |

