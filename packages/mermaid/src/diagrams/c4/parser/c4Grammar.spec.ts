import c4Db from '../c4Db.js';
// @ts-ignore: JISON doesn't support types
import c4 from './c4Diagram.jison';
import { setConfig } from '../../../config.js';
import detector from '../c4Detector.js';

setConfig({
  securityLevel: 'strict',
});

describe('the C4 grammar', () => {
  beforeEach(() => {
    c4.parser.yy = c4Db;
    c4.parser.yy.clear();
  });

  const parse = (text: string) => c4.parser.parse(text);
  const yy = () => c4.parser.yy as typeof c4Db;

  describe('direction', () => {
    it.each([
      ['TB', 'TB'],
      ['TD', 'TB'],
      ['BT', 'BT'],
      ['LR', 'LR'],
      ['RL', 'RL'],
    ])('reads "direction %s"', (written, expected) => {
      parse(`C4Context
direction ${written}
Person(a, "A")`);
      expect(yy().getDirection()).toBe(expected);
    });

    it('defaults to top to bottom', () => {
      parse(`C4Context
Person(a, "A")`);
      expect(yy().getDirection()).toBe('TB');
    });

    it('takes a direction statement anywhere among the others', () => {
      parse(`C4Context
Person(a, "A")
direction LR
System(b, "B")`);
      expect(yy().getDirection()).toBe('LR');
      expect(yy().getC4ShapeArray()).toHaveLength(2);
    });

    it('does not mistake text mentioning a direction for the statement', () => {
      parse(`C4Context
Person(a, "Reads the direction TB of the flow")
Rel(a, a, "direction LR")`);
      expect(yy().getDirection()).toBe('TB');
      expect(yy().getC4ShapeArray()[0].label.text).toBe('Reads the direction TB of the flow');
    });
  });

  describe('title and accessibility', () => {
    it('accepts # and ; in a title (#8030)', () => {
      parse(`C4Context
title Sprint #3; release (#4864)
Person(a, "A")`);
      expect(yy().getTitle()).toBe('Sprint #3; release (#4864)');
    });

    it('accepts # in an accDescription', () => {
      parse(`C4Context
accDescription covers issue #4864
Person(a, "A")`);
      expect(yy().getAccDescription()).toBe('covers issue #4864');
    });

    it('sets the accessible title, not the visible one, from accTitle (#8040)', () => {
      parse(`C4Context
accTitle: an accessible title
Person(a, "A")`);
      expect(yy().getAccTitle()).toBe('an accessible title');
      expect(yy().getTitle()).toBe('');
    });

    it('accepts a title after the elements', () => {
      parse(`C4Context
Person(a, "A")
title Late title`);
      expect(yy().getTitle()).toBe('Late title');
    });
  });

  describe('empty parts', () => {
    it('parses a diagram with nothing in it', () => {
      expect(() => parse('C4Context')).not.toThrow();
      expect(() => parse('C4Container\n')).not.toThrow();
      expect(yy().getC4ShapeArray()).toHaveLength(0);
    });

    it('parses an empty boundary, on one line or several', () => {
      parse(`C4Context
Boundary(b1, "One line") {}
System_Boundary(b2, "Two lines") {
}
Person(a, "A")`);
      expect(
        yy()
          .getBoundaries()
          .map((b) => b.alias)
      ).toEqual(['global', 'b1', 'b2']);
      expect(yy().getC4ShapeArray()[0].parentBoundary).toBe('global');
    });
  });

  describe('relationships', () => {
    it('keeps every relationship, even between the same pair (#7183)', () => {
      parse(`C4Dynamic
System(a, "A")
System(b, "B")
Rel(a, b, "Interaction 1")
Rel(a, b, "Interaction 2")`);
      expect(
        yy()
          .getRels()
          .map((rel) => rel.label.text)
      ).toEqual(['Interaction 1', 'Interaction 2']);
    });

    it('styles every relationship between the named pair', () => {
      parse(`C4Context
System(a, "A")
System(b, "B")
Rel(a, b, "one")
Rel(a, b, "two")
UpdateRelStyle(a, b, $lineColor="red", $offsetY="10")`);
      for (const rel of yy().getRels()) {
        expect(rel.lineColor).toBe('red');
        expect(rel.offsetY).toBe(10);
      }
    });
  });

  describe('the model', () => {
    it('records elements and boundaries in declaration order', () => {
      parse(`C4Container
Person(user, "User")
System_Boundary(sys, "System") {
  Container(web, "Web")
}
System_Ext(mail, "Mail")`);
      expect(yy().getDeclarationOrder()).toEqual(['user', 'sys', 'web', 'mail']);
    });

    it('gives a plain boundary and a deployment node no type unless one is written', () => {
      parse(`C4Deployment
Boundary(b, "Plain") {
}
Deployment_Node(n, "Node") {
}
Deployment_Node(t, "Typed", "Ubuntu") {
}
System_Boundary(s, "System") {
}`);
      const type = (alias: string) =>
        yy()
          .getBoundaries()
          .find((b) => b.alias === alias)!.type;
      expect(type('b').text).toBe('');
      expect(type('n').text).toBe('');
      expect(type('t').text).toBe('Ubuntu');
      expect(type('s').text).toBe('SYSTEM');
    });

    it('stores a technology from UpdateElementStyle as text', () => {
      parse(`C4Container
Container(web, "Web")
UpdateElementStyle(web, $techn="Node.js")`);
      expect(yy().getC4ShapeArray()[0].techn).toEqual({ text: 'Node.js' });
    });
  });
});

describe('the C4 detector', () => {
  it.each(['C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment'])(
    'recognises a diagram opening with %s',
    (keyword) => {
      expect(detector.detector(`  ${keyword}\nPerson(a, "A")`, {})).toBe(true);
    }
  );

  it('ignores a diagram that merely mentions a C4 keyword', () => {
    expect(detector.detector('flowchart TD\n  A[C4Container] --> B', {})).toBe(false);
    expect(detector.detector('sequenceDiagram\n  C4Component->>B: hi', {})).toBe(false);
  });

  it('ignores a keyword that only starts a longer word', () => {
    expect(detector.detector('C4ContextFoo', {})).toBe(false);
  });
});
