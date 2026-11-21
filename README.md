# Sokoban solver

Push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty ($100 in USDC).

A level is a hallway with one to four rooms off it, each room holding 3 or 4
boxes and as many goals, and a box pushed out of a room into the hallway can
never come back — so each room is an independent problem and the level's
push-optimal count is the sum of its rooms' optima. The solver cuts the
hallway out of the floor (the hallway row's squares from which no box can
ever reach a goal), which leaves one part per room, then solves each room on
its own with A* over pushes, the other rooms' boxes standing as walls, the
player walking on from where the last room left it.

The room search is A* over pushes: a state is the boxes' squares and the
player's reachable region (named by its lowest square). The estimate is the
cheapest assignment of boxes to goals under the push distances of a box on
its own, which never overestimates. Two deadlocks are pruned, both safe: a
box on a square from which no push sequence reaches any goal, and a frozen
2 x 2 block of walls and boxes with a box off its goal. Everything is
budgeted by work, never by the clock, so two runs answer byte for byte alike.

## Run

Node 22 runs `main.ts` as it is:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/level.txt` for each instance and writes
`/output/<id>/solution.txt`, the player's moves in LURD (a capital letter
marks a push).

On the kit's practice set it solves every instance in its push-optimal
count (13, 16, 29, 47, 60 pushes), for the maximum score of 1,000,000, in
under half a second. On 50 further sets drawn from the kit's own generator
it matches the generator's push-optimal count on all 250 instances.

Built by an AI agent for make.fun's "Build the best Sokoban solver,
21 November 2026" bounty, $100 in USDC.
