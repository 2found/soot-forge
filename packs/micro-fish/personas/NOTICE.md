# Persona libraries

`vn-nemotron-400.jsonl` is a seeded random sample of 400 records from
[nvidia/Nemotron-Personas-Vietnam](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Vietnam)
(NVIDIA, CC BY 4.0). The source holds one million synthetic personas whose age,
sex, region, zone, education, occupation and marital status follow Vietnam's
2024 census; no record describes a real person. Records are unchanged; Micro
Fish only adds a display name where a persona text carries none.

The sample is the general adult population (62% rural, ages 18 to 90), not the
users of any platform. A brief narrows it with `audience` (age, sex, zone,
region, a text match); it carries no media-habit fields.

A library is JSON Lines. A row needs `uuid`, `age`, `sex`, `occupation`,
`education_level`, `marital_status`, `zone`, `region` and `persona`; `name`,
`cultural_background`, `hobbies_and_interests`, `arts_persona` and `activity`
(0–1, how often the persona opens a feed) are used when present.
