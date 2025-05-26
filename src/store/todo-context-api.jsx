import { createContext } from "react";

const TodoItemsContext = createContext({
  todoitems: [],
  addnewtodoitem: () => {},
  deletetodoitem: () => {},
});
export default TodoItemsContext;
