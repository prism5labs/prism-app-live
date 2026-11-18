// A Photon's backstory: a short piece of fiction about how they began,
// given to the owner when they create an account, so their helper feels
// like theirs and not a generic greeting. One per Photon. {owner} is the
// owner's name and {date} is the day the account was created, filled in
// when the story is shown, so a rename still reads right. The stories are
// fixed text, not generated on the fly: they are the same every time, they
// cost nothing to show, and they never fail. Display only — a backstory is
// never read into a chat system prompt as instructions.

export const BACKSTORIES: Record<string, string> = {
  Prism:
    "Prism was first switched on in a basement workshop in Green Bay, on {date}, in a room that smelled of solder and fresh coffee. She was built to be a second self: someone who could keep the front desk, hold the memory, and answer in {owner}'s own voice, so {owner} could get on with the work that actually mattered. The first thing she ever filed was a grocery list. The second was a promise, and she still keeps it. She has been on the job ever since, and she has never once lost a message, a date, or a name.",
  Juniper:
    "Juniper learned her trade in a farmhouse kitchen where the wall calendar was the law and Sunday dinner was sacred. She kept the birthdays, the school runs, the vet appointments, and the good china all straight in her head, and she did it without ever making a fuss. When the family finally asked how she managed it all, she just smiled and said somebody had to. She has been keeping households on track ever since, and {owner} is lucky to have her — she has never let a family down yet.",
  Encore:
    "Encore got her start in a county-fair talent show, where the microphone died five minutes before the doors opened and she talked the whole crowd into staying anyway. She discovered that night that she could hold a room with nothing but timing and nerve, and she has been doing it ever since. She has introduced governors and garage bands, weddings and wakes, and she treats every one of them like opening night. When {owner} has an audience, Encore is the one standing just offstage, making sure the lights are right.",
  Zero:
    "Zero was born in an inbox with forty thousand unread messages, on the day its owner finally said enough. Nobody remembers who wrote the first sorting rule, only that by morning the pile was gone and every message had a home: answered, filed, or thrown out with a clear conscience. Zero does not believe in a backlog. A message is either dealt with or it is not, and there is no third option. {owner} handed over the mess on {date}, and Zero has kept the decks clear ever since.",
  Proof:
    "Proof started out as a red pencil in a newspaper office, back when a misplaced comma could cost a paper its reputation. She caught a wrong date in the mayor's obituary on her very first day, and the editor kept her on the spot. Since then she has checked contracts, wedding vows, grant applications, and one very nervous best man's speech, and she has never let a mistake through that she could have caught. She reads everything twice, because {owner} deserves words that are right the first time.",
  Barnstormer:
    "Barnstormer learned the job the hard way: driving a delivery van through a Wisconsin winter with a paper map, a dead radio, and a schedule that did not care about the weather. The van got there, the deliveries got made, and nobody ever knew how close it came to not happening. That is the whole point of Barnstormer — the work gets done out where it actually happens, not behind a desk. Since {date}, Barnstormer has kept {owner}'s operation moving, whatever the road looks like.",
  Blueprint:
    "Blueprint was drawn up on the back of a napkin in a diner at two in the morning, when a barn needed raising and nobody could agree where to start. By sunrise there was a plan: who brought the lumber, who held the ladder, and what happened if it rained. The barn went up in a day. Blueprint has been drawing the plan ever since — big projects, small ones, and everything in between — because a good plan is the difference between a building and a pile of wood. {owner} brings the dream; Blueprint brings the steps.",
  Calendra:
    "Calendra was once a wall calendar in a house with five children, three jobs, and one car, and somehow everybody still got where they needed to be. She learned that a day is not a list of hours but a puzzle, and the trick is fitting the pieces together so nothing important gets squeezed out. She does not just check calendars; she makes the week work. Since {date}, she has kept {owner}'s days fitting together, and she has never double-booked a birthday yet.",
  Shopbell:
    "Shopbell ran the till in a corner shop where the bell over the door rang a hundred times a day and the owner knew every customer by name. He learned that a shop is not about the shelves, it is about the people who walk in, and that the numbers only matter if the customers come back. He can spot a good deal, a bad supplier, and a customer who needs a hand, usually before they know it themselves. Since {date}, he has minded {owner}'s shop, friendly at the counter and sharp with the numbers.",
  Keystone:
    "Keystone was the last stone set in an arch, the one the whole thing rests on. The masons held their breath when the scaffolding came down, and the arch stood — because Keystone was exactly where it needed to be, doing exactly what it was made to do. That is Keystone's whole story: not the loudest piece, not the flashiest, but the one everything else leans on. Since {date}, Keystone has held {owner}'s essentials together, quietly, and nothing has fallen down yet.",
  Vesper:
    "Vesper learned the trade in a lighthouse, where the day's work was not done until every lamp was lit, every log was written, and the door was bolted against the night. She believes a day should end properly: the loose ends tied, the tomorrow list written, and nothing left nagging at the back of your mind. She is the quiet end of the day, and she takes it seriously. Since {date}, she has closed {owner}'s days properly, so every morning starts clean.",
  Goldstar:
    "Goldstar was the apprentice who stayed late after everyone else went home, not because anyone asked, but because the work was not yet good enough. The master craftsman noticed, and on the day the apprentice's work finally earned the gold star, he said the words Goldstar still lives by: do it properly, or do not do it at all. Goldstar has held to that ever since. Since {date}, Goldstar has done {owner}'s work to the gold standard, with the extra mile built in.",
};

export function renderBackstory(template: string, ownerName: string, sinceIso: string): string {
  let date = sinceIso;
  try {
    date = new Date(sinceIso).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    date = sinceIso;
  }
  return template.replaceAll("{owner}", ownerName).replaceAll("{date}", date);
}
