// Interaction model for M037's authored book-selection example.
// Page counts are task data; the shared book geometry is illustrative.
const safeBookId = value => /^[A-C]$/.test(value);

export function createBookTask(taskExample) {
  if (taskExample?.prompt !== 'Choose the book with a blue cover and fewer than 200 pages.' ||
      !Array.isArray(taskExample.options) || taskExample.options.length !== 3) {
    throw new TypeError('M037 book task must retain its three authored options and prompt');
  }
  const books = taskExample.options.map(option => {
    if (!safeBookId(option.id)) throw new TypeError('Book id must be A, B, or C');
    const match = /^(Blue|Red) cover; (\d+) pages$/.exec(option.detail);
    if (!match) throw new TypeError(`Invalid authored details for book ${option.id}`);
    return Object.freeze({ id: option.id, cover: match[1].toLowerCase(), pages: Number(match[2]), detail: option.detail });
  });
  if (books.map(book => book.id).join('') !== 'ABC') throw new TypeError('Books must remain ordered A, B, C');
  const words = taskExample.interaction;
  if (!words?.groupLabel || !words.figure || !words.open || !words.close || !words.inspect || !words.status || !words.openState || !words.closedState ||
      !words.result?.both || !words.result.coverOnly || !words.result.pagesOnly || !words.result.neither) {
    throw new TypeError('M037 book interaction copy must be supplied by lesson content');
  }
  const answer = books.find(book => book.cover === 'blue' && book.pages < 200);
  if (answer?.id !== 'C') throw new TypeError('Authored task must have C as its unique answer');

  const inspect = (id, open = 0) => {
    if (!safeBookId(id) || !Number.isFinite(open) || open < 0 || open > 1) throw new TypeError('Choose a book and a normalized open pose');
    const book = books.find(item => item.id === id);
    if (!book) throw new TypeError(`Unknown book: ${id}`);
    const coverMatches = book.cover === 'blue';
    const pagesMatch = book.pages < 200;
    const result = coverMatches && pagesMatch ? words.result.both
      : coverMatches ? words.result.coverOnly
        : pagesMatch ? words.result.pagesOnly
          : words.result.neither;
    return Object.freeze({ book, open, coverMatches, pagesMatch, correct: coverMatches && pagesMatch, result, words });
  };
  return Object.freeze({ prompt: taskExample.prompt, books: Object.freeze(books), answer: answer.id, words, inspect });
}
