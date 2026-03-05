/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "gremlin" {
  namespace process {
    interface GraphTraversalSource {
      V(...ids: any[]): GraphTraversal;
      E(...ids: any[]): GraphTraversal;
    }

    interface GraphTraversal {
      V(...ids: any[]): GraphTraversal;
      hasLabel(...labels: string[]): GraphTraversal;
      has(key: string, value?: any): GraphTraversal;
      out(...labels: string[]): GraphTraversal;
      in_(...labels: string[]): GraphTraversal;
      outE(...labels: string[]): GraphTraversal;
      inE(...labels: string[]): GraphTraversal;
      outV(): GraphTraversal;
      inV(): GraphTraversal;
      otherV(): GraphTraversal;
      bothE(...labels: string[]): GraphTraversal;
      both(...labels: string[]): GraphTraversal;
      id(): GraphTraversal;
      label(): GraphTraversal;
      hasId(...ids: any[]): GraphTraversal;
      count(): GraphTraversal;
      fold(): GraphTraversal;
      unfold(): GraphTraversal;
      select(...keys: string[]): GraphTraversal;
      as(label: string): GraphTraversal;
      project(...keys: string[]): GraphTraversal;
      where(predicate: GraphTraversal): GraphTraversal;
      dedup(): GraphTraversal;
      order(): GraphTraversal;
      by(key: string, direction?: string): GraphTraversal;
      limit(n: number): GraphTraversal;
      valueMap(...keys: (string | boolean)[]): GraphTraversal;
      values(...keys: string[]): GraphTraversal;
      toList(): Promise<any[]>;
      next(): Promise<{ value: any; done: boolean }>;
    }

    const statics: {
      out(...labels: string[]): GraphTraversal;
      in_(...labels: string[]): GraphTraversal;
      has(key: string, value?: any): GraphTraversal;
      otherV(): GraphTraversal;
      hasId(...ids: any[]): GraphTraversal;
    };
  }

  namespace driver {
    class DriverRemoteConnection {
      constructor(url: string, options?: Record<string, any>);
      close(): Promise<void>;
    }
  }

  namespace structure {
    class Graph {
      traversal(): {
        withRemote(connection: any): process.GraphTraversalSource;
      };
    }
  }

  const gremlin: {
    driver: typeof driver;
    structure: typeof structure;
    process: typeof process & {
      GraphTraversalSource: process.GraphTraversalSource;
      AnonymousTraversalSource: {
        traversal(): {
          withRemote(connection: any): process.GraphTraversalSource;
        };
      };
      statics: typeof process.statics;
    };
  };

  export default gremlin;
}
