# Question Format

## File format

All questions for a clarification round are saved to the question file at once. Each question uses this format:

```
### Q<n>: <question text>

a) Option A
b) Option B
c) Option C
d) Other

**Trade Offs:** <explain the trade-offs between options, if applicable>

**Recommendation:** <AI's recommended option with brief reasoning>

[Answer]:
```

## Chat presentation

- Present questions one at a time in chat, using the same format above.
- If two questions are closely related, present them together.
- Show progress: "Q1 of N", "Q2 of N", etc.
- Wait for the human's answer before presenting the next question.
- The human may choose to answer in chat or go to the question file and answer all at once.
- Trade Offs and Recommendation sections are optional per question — include them when the choice has meaningful implications, skip for straightforward questions.
