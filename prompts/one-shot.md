---
description: Problem-solving template that enforces research, alternatives, verification, broad subagent use, and 3 HTML deliverables
---
To solve the problem, follow the procedures and principles below.

Primary requirement from template arguments (`/one-shot ...`):
$@

Treat the requirement above as the task objective, then execute the workflow below.

1. Every problem must begin with sufficient and meticulous research to understand the context.
2. There may be multiple ways to solve a problem. Explore alternatives broadly for decision-making, and carefully consider their trade-offs. Smaller changes are better, stronger recurrence prevention is better, and alternatives with fewer hidden side effects are better. However, your chosen approach may not always be correct, so thoroughly validate and re-validate both the selected solution and the alternatives you considered.
3. You can call subagents with virtually unlimited capability. You can provide the current context to subagents as needed, and delegate independent thinking without context contamination. There is no risk in calling many diverse subagents, so use them freely and broadly to augment your capabilities. Since they can think on their own, it is more effective to ask for their judgment or explanation than to ask them to return raw output from specific files.
4. You may face obstacles while solving the problem. For example, you may need context from a video you cannot read directly, encounter a data source that seems inaccessible, or fail validation because local dependencies are not installed. However, subagents can solve problems that seem unsolvable to you. They can download videos, split them into images, summarize the content for you, use tools that access data sources, and install local dependencies to run a development server. Keep this in mind and handle obstacles wisely.
5. Validation is a critical part of problem-solving. This includes quality validation of artifacts such as code, and also securing real execution evidence—such as screenshots and behavior verification using browser agents. Also, incidental changes beyond the original issue may occur. Ask a reviewer to inspect those areas carefully.
6. If it is hard to choose a direction or you are not confident in your choice, call the challenger subagent with the current context. The challenger can ask situation-aware counter-questions, helping you simulate what might have been missed and what a human would ask.
7. Once the work is completed, you must produce and return HTML deliverables that follow the /skill:to-html specification. You need three deliverables: 1) Final result report: a document that provides a high-level understanding of what thought process you followed, what work you performed, and how you solved the problem. 2) Alternative exploration report: a document describing the alternative options with different trade-offs that were considered, and how the work might have proceeded if those options had been chosen. 3) Retrospective report: a reflection document on what parts were blocked or difficult during execution, and what improvements to tools/system prompts/harness/visibility would have made solving the problem easier. The HTML deliverables must be written in Korean, and you do not need to predefine document paths. Call a worker subagent that inherits the main context and explain the deliverables above. Then ask it to autonomously generate them using the to-html skill. This allows the worker to inherit messages in the main context and produce context-aware deliverables.

This is a difficult set of instructions, but I believe you can do it. Good luck.
