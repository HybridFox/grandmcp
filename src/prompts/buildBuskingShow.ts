import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const GUIDE = `You are helping the user build a grandMA3 show for busking: playing lights live to music, by combining
looks, palettes and effects on executors instead of running a programmed cue list. The layout is the user's design.
Propose, explain and ask; build in small steps and show what you built after each one.

1. Understand the rig. Call grandmcp_status, grandmcp_patch_list, grandmcp_group_list, grandmcp_preset_list,
   grandmcp_sequence_list and grandmcp_executor_list. For each fixture type, call grandmcp_fixture_attributes to see
   what it can do (colour mixing or wheel, gobos, zoom, strobe, movement). Note which pool slots and executors are
   already used: never overwrite them without asking.
2. Ask the user before building:
   - which music styles and tempo ranges they play (for example techno 125-140, house 118-128, rock, ambient),
   - how they play: which faders and buttons they have (onPC, a wing, a console) and how many pages they want,
   - preferences: colours they like or avoid, how much movement and strobe, whether the audience gets light.
3. Groups. One per fixture type and position (for example "Polars left", "Robins front"), in a sensible selection
   order (left to right, or outside in): effects and phase spreads follow that order. Use grandmcp_group_store.
4. Palettes (presets), with a numbering scheme the user can remember: the same slot means the same thing in every
   pool (for example colour 1 = red, 2 = amber, 3 = white for every group).
   - Colour: a set of named colours that work on every fixture type in the rig. Mixing fixtures use percentages;
     wheel fixtures use the closest slot; check what grandmcp_fixture_attributes offers.
   - Position: centre, audience, floor, fans, crossed, up. Ask how fixtures are hung before inventing angles.
   - Beam and gobo: open, a few gobos, prism, zoom wide and narrow.
   Use grandmcp_preset_store and report anything it could not verify.
5. Effects (presets with an effect value), each linked to a speed master so a BPM tap drives it. A common split:
   speed master 1 for dimmer effects, 2 for colour effects, 3 for movement. Build a few variants per type:
   - dimmer: chase (phase 0-360 across the group), sine, random-feeling (uneven phase), strobe,
   - colour: two- or three-colour chases using the palette colours,
   - movement: pan sweep, tilt wave, circle; small and large versions.
   Phase spreads give the pattern: 0-360 is a chase, 0-180 a softer wave, the same phase everywhere is unison.
   The effect's pattern option shapes it further: wings 2 mirrors it (outside in), wings 2 + invert runs from the
   centre out, groups 2 gives odd/even. Also store a few MAtricks (grandmcp_matricks_store) to vary effects live.
6. Sequences and executors. Turn the building blocks into things to play, referencing presets so the user can change
   a palette once:
   - base looks per style (colour + position + beam), one cue each or a short cue list,
   - effect layers as separate sequences (dimmer FX, colour FX, movement FX) so they can be combined live,
   - utilities: blinder or full-on flash, strobe, blackout.
   Propose the executor layout to the user and only assign it once they agree (grandmcp_executor_assign), then set
   fader and button functions (grandmcp_executor_configure: effect layers on Toggle or Flash, utilities on Flash),
   put the speed masters on executors as tap buttons (grandmcp_speedmaster_set) and name the pages
   (grandmcp_page_store).
7. Styles. Variations rather than separate shows: per style mainly different palettes, effect speeds and intensity.
   For example: techno = cold colours, fast dimmer chases and strobe; house = warm colours, slower chases, more
   movement; ambient = slow fades, few effects.
8. Make it readable: colour the buttons with appearances that match their content (grandmcp_appearance_store) and
   build a layout view of the rig (grandmcp_layout_store). To adjust later, read with grandmcp_preset_read /
   grandmcp_sequence_read and edit single cues with grandmcp_cue_store.
9. Check your work. grandmcp_screenshot shows a grandMA3 screen; if the user has a 3D window there, look at it after
   building a look. Never answer grandMA3 pop-ups yourself: tell the user what they ask.
10. Finish with a map of what is where: groups, palette numbers, effects and speed masters, sequences and executors,
   so the user can play it without asking you.`;

export function registerBuildBuskingShowPrompt(server: McpServer): void {
	server.registerPrompt(
		'build_busking_show',
		{
			title: 'Build a busking show',
			description: 'Guide for building groups, palettes, effects and executors for playing lights live, with the user deciding the layout.',
			argsSchema: z.object({ styles: z.string().optional().describe('Music styles to cover, e.g. "techno, house".') }),
		},
		({ styles }) => ({
			messages: [
				{
					role: 'user' as const,
					content: { type: 'text' as const, text: styles ? `${GUIDE}\n\nThe user wants to cover: ${styles}.` : GUIDE },
				},
			],
		}),
	);
}
