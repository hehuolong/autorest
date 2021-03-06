/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as yamlAst from "yaml-ast-parser";
import { JsonPath } from "./jsonpath";
import { NewEmptyObject } from "../parsing/stable-object";

/**
 * reexport required elements
 */
export { newScalar } from "yaml-ast-parser";
export const Kind: { SCALAR: number, MAPPING: number, MAP: number, SEQ: number, ANCHOR_REF: number, INCLUDE_REF: number } = yamlAst.Kind;
export type YAMLNode = yamlAst.YAMLNode;
export type YAMLScalar = yamlAst.YAMLScalar;
export type YAMLMapping = yamlAst.YAMLMapping;
export type YAMLMap = yamlAst.YamlMap;
export type YAMLSequence = yamlAst.YAMLSequence;
export type YAMLAnchorReference = yamlAst.YAMLAnchorReference;

export const CreateYAMLMapping: (key: YAMLScalar, value: YAMLNode) => YAMLMapping = yamlAst.newMapping;
export const CreateYAMLScalar: (value: string) => YAMLScalar = yamlAst.newScalar;

export interface YAMLNodeWithPath {
  path: JsonPath;
  node: YAMLNode;
}

/**
 * Parsing
*/
export function ParseToAst(rawYaml: string): YAMLNode {
  return yamlAst.safeLoad(rawYaml, null) as YAMLNode;
}

export function* Descendants(yamlAstNode: YAMLNode, currentPath: JsonPath = [], deferResolvingMappings: boolean = false): Iterable<YAMLNodeWithPath> {
  const todos: YAMLNodeWithPath[] = [{ path: currentPath, node: yamlAstNode }];
  let todo: YAMLNodeWithPath | undefined;
  while (todo = todos.pop()) {
    // report self
    yield todo;

    // traverse
    if (todo.node) {
      switch (todo.node.kind) {
        case Kind.MAPPING: {
          let astSub = todo.node as YAMLMapping;
          if (deferResolvingMappings) {
            todos.push({ node: astSub.value, path: todo.path });
          } else {
            todos.push({ node: astSub.value, path: todo.path.concat([astSub.key.value]) });
          }
        }
          break;
        case Kind.MAP:
          if (deferResolvingMappings) {
            for (let mapping of (todo.node as YAMLMap).mappings) {
              todos.push({ node: mapping, path: todo.path.concat([mapping.key.value]) });
            }
          } else {
            for (let mapping of (todo.node as YAMLMap).mappings) {
              todos.push({ node: mapping, path: todo.path });
            }
          }
          break;
        case Kind.SEQ: {
          let astSub = todo.node as YAMLSequence;
          for (let i = 0; i < astSub.items.length; ++i) {
            todos.push({ node: astSub.items[i], path: todo.path.concat([i]) });
          }
        }
          break;
      }
    }
  }

}

export function ResolveAnchorRef(yamlAstRoot: YAMLNode, anchorRef: string): YAMLNodeWithPath {
  for (let yamlAstNode of Descendants(yamlAstRoot)) {
    if (yamlAstNode.node.anchorId === anchorRef) {
      return yamlAstNode;
    }
  }
  throw new Error(`Anchor '${anchorRef}' not found`);
}

/**
 * Populates yamlNode.valueFunc with a function that creates a *mutable* object (i.e. no caching of the reference or such)
 */
function ParseNodeInternal(yamlRootNode: YAMLNode, yamlNode: YAMLNode, onError: (message: string, index: number) => void): () => any {
  if (!yamlNode) {
    return () => null;
  }
  if (yamlNode.errors.length > 0) {
    for (const error of yamlNode.errors) {
      onError(`Syntax error: ${error.reason}`, error.mark.position);
    }
    return (yamlNode as any).valueFunc = () => null;
  }
  if ((yamlNode as any).valueFunc) {
    return (yamlNode as any).valueFunc;
  }

  switch (yamlNode.kind) {
    case Kind.SCALAR: {
      const yamlNodeScalar = yamlNode as YAMLScalar;
      return (yamlNode as any).valueFunc = yamlNodeScalar.valueObject !== undefined
        ? () => yamlNodeScalar.valueObject
        : () => yamlNodeScalar.value;
    }
    case Kind.MAPPING:
      onError("Syntax error: Encountered bare mapping.", yamlNode.startPosition);
      return (yamlNode as any).valueFunc = () => null;
    case Kind.MAP: {
      const yamlNodeMapping = yamlNode as YAMLMap;
      return (yamlNode as any).valueFunc = () => {
        const result = NewEmptyObject();
        for (const mapping of yamlNodeMapping.mappings) {
          if (mapping.key.kind !== Kind.SCALAR) {
            onError("Syntax error: Only scalar keys are allowed as mapping keys.", mapping.key.startPosition);
          } else if (mapping.value === null) {
            onError("Syntax error: No mapping value found.", mapping.key.endPosition);
          } else {
            result[mapping.key.value] = ParseNodeInternal(yamlRootNode, mapping.value, onError)();
          }
        }
        return result;
      };
    }
    case Kind.SEQ: {
      const yamlNodeSequence = yamlNode as YAMLSequence;
      return (yamlNode as any).valueFunc = () =>
        yamlNodeSequence.items.map(item => ParseNodeInternal(yamlRootNode, item, onError)());
    }
    case Kind.ANCHOR_REF: {
      const yamlNodeRef = yamlNode as YAMLAnchorReference;
      return (ResolveAnchorRef(yamlRootNode, yamlNodeRef.referencesAnchor).node as any).valueFunc;
    }
    case Kind.INCLUDE_REF:
      onError("Syntax error: INCLUDE_REF not implemented.", yamlNode.startPosition);
      return (yamlNode as any).valueFunc = () => null;
    default:
      throw new Error("Unknown YAML node kind.");
  }
}

export function ParseNode<T>(yamlNode: YAMLNode, onError: (message: string, index: number) => void = message => { throw new Error(message); }): T {
  ParseNodeInternal(yamlNode, yamlNode, onError);
  return (yamlNode as any).valueFunc();
}

export function CloneAst<T extends YAMLNode>(ast: T): T {
  if (ast.kind === Kind.MAPPING) {
    const astMapping = ast as YAMLMapping;
    return <T>CreateYAMLMapping(CloneAst(astMapping.key), CloneAst(astMapping.value));
  }
  return ParseToAst(StringifyAst(ast)) as T;
}
export function StringifyAst(ast: YAMLNode): string {
  return FastStringify(ParseNode<any>(ast));
}
export function Clone<T>(object: T): T {
  return Parse<T>(FastStringify(object));
}
/**
 * Normalizes the order of given object's keys (sorts recursively)
 */
export function Normalize<T>(object: T): T {
  const clone = Clone<T>(object);
  const norm = (o: any) => {
    if (Array.isArray(o)) {
      o.forEach(norm);
    } else if (o && typeof o == "object") {
      const keys = Object.keys(o).sort();
      const oo = { ...o };
      for (const k of keys) {
        delete o[k];
      }
      for (const k of keys) {
        norm(o[k] = oo[k]);
      }
    }
  };
  norm(clone);
  return clone;
}
export function ToAst<T>(object: T): YAMLNode {
  return ParseToAst(FastStringify(object));
}

export function Parse<T>(rawYaml: string, onError: (message: string, index: number) => void = message => { throw new Error(message); }): T {
  const node = ParseToAst(rawYaml);
  const result = ParseNode<T>(node, onError);
  return result;
}

export function Stringify<T>(object: T): string {
  return "---\n" + yamlAst.safeDump(object, { skipInvalid: true });
}

export function FastStringify<T>(obj: T): string {
  try {
    return JSON.stringify(obj, null, 1);
  } catch (e) {
    return Stringify(obj);
  }
}
