import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Fonts, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * Just enough Markdown for chat answers: headings, lists, quotes, code blocks, rules, and bold,
 * italics and code inside a line. Anything else shows as written. A table shows as its text.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <View style={styles.blocks}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </View>
  );
});

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; items: { marker: string; text: string; depth: number }[] }
  | { kind: 'rule' };

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      // An unclosed fence (an answer still being written) runs to the end.
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].replace(/\s#+$/, '') });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: { marker: string; text: string; depth: number }[] = [];
      for (; i < lines.length; i++) {
        const item = LIST_ITEM.exec(lines[i]);
        if (item) {
          const [, indent, marker] = item;
          items.push({ marker: /\d/.test(marker) ? marker.replace(')', '.') : '•', text: item[3], depth: Math.min(3, Math.floor(indent.length / 2)) });
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
        } else break;
      }
      blocks.push({ kind: 'list', items });
      continue;
    }
    const paragraph: string[] = [];
    // The first line always goes in, so a line no other block takes can't stall the loop.
    for (; i < lines.length && lines[i].trim() && (!paragraph.length || !startsBlock(lines[i])); i++) {
      paragraph.push(lines[i].trim());
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

const startsBlock = (line: string) => /^\s*(```|#{1,6}\s|>)/.test(line) || LIST_ITEM.test(line);

/** While an answer streams, only its last block changes; the rest stay as they were. */
const BlockView = memo(BlockContent, (a, b) => JSON.stringify(a.block) === JSON.stringify(b.block));

function BlockContent({ block }: { block: Block }) {
  const theme = useTheme();
  switch (block.kind) {
    case 'paragraph':
      return (
        <ThemedText selectable style={styles.body}>
          <Inline text={block.text} />
        </ThemedText>
      );
    case 'heading':
      return (
        <ThemedText selectable style={block.level <= 2 ? styles.heading : styles.subheading}>
          <Inline text={block.text} />
        </ThemedText>
      );
    case 'code':
      return (
        <View style={[styles.code, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText selectable style={styles.codeText}>
            {block.text}
          </ThemedText>
        </View>
      );
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: theme.backgroundSelected }]}>
          <Markdown text={block.text} />
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {block.items.map((item, i) => (
            <View key={i} style={[styles.item, { paddingLeft: item.depth * Spacing.three }]}>
              <ThemedText style={[styles.body, styles.marker]} themeColor="textSecondary">
                {item.marker}
              </ThemedText>
              <ThemedText selectable style={[styles.body, styles.itemText]}>
                <Inline text={item.text} />
              </ThemedText>
            </View>
          ))}
        </View>
      );
    case 'rule':
      return <View style={[styles.rule, { backgroundColor: theme.backgroundSelected }]} />;
  }
}

/** `code`, **bold**, *italic* or _italic_, and [links](…) shown as their text. */
function Inline({ text }: { text: string }) {
  const theme = useTheme();
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*(.+?)\*\*|__(.+?)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const [, code, bold, bold2, italic, italic2, link] = m;
    const key = parts.length;
    if (code !== undefined) {
      parts.push(
        <ThemedText key={key} style={[styles.inlineCode, { backgroundColor: theme.backgroundElement }]}>
          {code}
        </ThemedText>,
      );
    } else if (bold ?? bold2) {
      parts.push(
        <ThemedText key={key} style={styles.bold}>
          <Inline text={(bold ?? bold2)!} />
        </ThemedText>,
      );
    } else if (italic ?? italic2) {
      parts.push(
        <ThemedText key={key} style={styles.italic}>
          <Inline text={(italic ?? italic2)!} />
        </ThemedText>,
      );
    } else {
      parts.push(<Fragment key={key}>{link}</Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const styles = StyleSheet.create({
  blocks: {
    gap: Spacing.two + Spacing.one,
  },
  body: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 400,
  },
  heading: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: 700,
  },
  subheading: {
    fontSize: 17,
    lineHeight: 24,
    fontWeight: 700,
  },
  code: {
    borderRadius: 8,
    padding: Spacing.two + Spacing.one,
  },
  codeText: {
    fontFamily: Fonts?.mono,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 400,
  },
  inlineCode: {
    fontFamily: Fonts?.mono,
    fontSize: 15,
    fontWeight: 400,
  },
  bold: {
    fontWeight: 700,
  },
  italic: {
    fontStyle: 'italic',
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: Spacing.three,
  },
  list: {
    gap: Spacing.one,
  },
  item: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  marker: {
    minWidth: 14,
  },
  itemText: {
    flex: 1,
  },
  rule: {
    height: StyleSheet.hairlineWidth,
  },
});
