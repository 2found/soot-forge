# Product, feature and pricing simulations

Use `kind: product`, `feature` or `pricing`.

## Stimuli

Write each stimulus as the persona would meet it, not as the team describes it internally:

- **Feature**: the entry point (where the user finds it), what it does in the user's words, what it costs or requires (sign-up, permission, data), and one concrete scenario. Include the real UI copy when it exists.
- **Product**: the landing-page promise, the 3–5 things it does, price and plan, the alternative people use today.
- **Pricing**: each price variant as its own stimulus with the exact plan table and currency per market. Set `price_ok` on every reaction.
- **A/B**: same length and same level of detail for every variant; neutral labels. A variant that is simply described better wins for the wrong reason.

Keep each stimulus under 3000 characters. Cut adjectives; keep facts.

## Questions worth asking

- Who would try it this week, and what stops everyone else?
- Which segment is the real early adopter? Which one will never come?
- What is the first confusion? (Low `clarity` with high `appeal` means good idea, bad explanation.)
- Is the price the objection, or the trust?
- What would make a skeptic change their mind? (Read the social rounds.)

## Population hints

Include current users of the alternative, people who tried and churned, price-sensitive buyers, a non-target segment that will see the launch anyway, and in B2B the buyer, the user and the blocker (IT, legal, finance). For US/EU/VN, vary income in local terms, platform habits (Zalo and Facebook in VN; email, Reddit and LinkedIn in US/EU), payment habits and privacy expectations (GDPR awareness in EU).

## Reading the numbers

- `intent_top2` = share of 4–5 on "would try / buy". Compare variants and segments, never against real-world conversion.
- A gap between `appeal` and `trust` points at proof, reviews or brand.
- Objection tags that grow from round 0 to the last round are contagious: fix them first.
- `price_ok` below half in a market where `appeal` is high means the price, not the product.
