# Motion and repair reference

## Contract

`assets/animation.json` at the pack root is the machine-readable geometry and
timing source. States: sleeping, idle, thinking, working, waiting, success,
error. Each source is 1536×1024, twelve cels in a 4×3 grid. Exported cells are
192×208; the full atlas is 2304×1456 and each state sheet is 768×624.

Awake blinks occupy 45 + 50 + 55 = 150 ms at frames 5–7. Other timings differ
by state: idle has a long open-eye hold, working a shorter hold, success/error
perform the gesture promptly and rest afterward. Use the manifest timings.

## Repair the observed fault

| Fault | Repair |
| --- | --- |
| Rolling/dancing pupils | Fixed eye centers, identical forward gaze/highlight in open cels; animate dark upper lids only |
| White disks remain on closed eyes | Replace with closed dark furry lid seams; no visible eyeball or pupil |
| Glasses vanish during blink | Target only frames 5–7; retain full circular rims, bridge and sides above lids |
| Third hand left on prop | Regenerate from the accepted open-eye free-hand reference, without the defective sheet as identity guide |
| Sleeping copies awake eyes | Attach the sleeping guide and explicitly keep all twelve cels closed |
| Alpha haze blocks extraction | Remove background/halo with imagegen; do not raise the alpha threshold to hide the defect |
| Scale pops between states | Check source camera first. Assembly registers whole rows to idle and feet; never fit each frame individually |
| Hand jumps at loop boundary | Repair last/first poses or a wrong inbetween; keep gesture rise/return coherent |

A generated row may put good drawings in the wrong order. After visual review,
`frame-order.json` in the job directory can reorder the existing twelve cels:

```json
{"soot-astronaut-error": [0, 9, 1, 2, 4, 5, 6, 8, 7, 3, 10, 11]}
```

This is an example from a prior defect, not a default correction. Use every
index 0–11 exactly once. Awake blink drawings must still occupy output slots
5–7. Never duplicate a frame or synthesize an inbetween to satisfy the count.

Repairs should target a faulty state or a specific visual invariant. If repeated
edits retain the same anatomy defect, change to a clean reference and simplify
the gesture. Preserve the earlier source and prompt until the replacement is
visually accepted. Distinguish minor fur texture variation from material gaze,
anatomy, accessory, clipping and timing errors.
