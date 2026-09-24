import { getGradebookColumnsSlugStringContext } from "@/lib/gradebookExpressionMonaco";

/** The text with `|` marking the caret, split into the text and the caret offset. */
function at(marked: string): [string, number] {
  const offset = marked.indexOf("|");
  return [marked.slice(0, offset) + marked.slice(offset + 1), offset];
}

describe("slug completion context", () => {
  it("offers slugs inside auto-closed quotes, empty or part typed", () => {
    expect(getGradebookColumnsSlugStringContext(...at('gradebook_column_group("|")'))).toMatchObject({
      kind: "gradebook_column_group",
      filter: ""
    });
    expect(getGradebookColumnsSlugStringContext(...at('mean(gradebook_column_group("qu|"))'))).toMatchObject({
      kind: "gradebook_column_group",
      filter: "qu"
    });
    expect(getGradebookColumnsSlugStringContext(...at('gradebook_columns("hw-|")'))).toMatchObject({
      kind: "gradebook_columns",
      filter: "hw-"
    });
  });

  it("offers slugs in an unclosed string", () => {
    expect(getGradebookColumnsSlugStringContext(...at('gradebook_columns("hw|'))).toMatchObject({ filter: "hw" });
  });

  it("offers nothing once the caret is past the closing quote", () => {
    expect(getGradebookColumnsSlugStringContext(...at('gradebook_columns("hw")|'))).toBeNull();
    expect(getGradebookColumnsSlugStringContext(...at('mean(|gradebook_columns("hw"))'))).toBeNull();
  });
});
