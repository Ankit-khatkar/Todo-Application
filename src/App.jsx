import Appname from "./Components/Appname";
import Mybtns from "./Components/Buttoncomps";
import Items from "./Components/TodoItms";
import Styles from "./App.module.css";
import { useReducer, useState } from "react";
import TodoItemsContext from "./store/todo-context-api";

const todoItemReducer = (currTodoItems, action) => {
  let newTodoItems = currTodoItems;
  if (action.type === "ADD_ITEM") {
    newTodoItems = [
      ...currTodoItems,
      { name: action.payload.todoname, Duedate: action.payload.tododate },
    ];
  } else if (action.type === "DELETE_ITEM") {
    newTodoItems = currTodoItems.filter(
      (item) => item.name !== action.payload.name
    );
  }
  return newTodoItems;
};
function App() {
  const [todoitems, dispatchTodoItem] = useReducer(todoItemReducer, []);
  const addnewtodoitem = (todoname, tododate) => {
    const newitemaction = {
      type: "ADD_ITEM",
      payload: {
        todoname,
        tododate,
      },
    };

    dispatchTodoItem(newitemaction);
  };
  const deletetodoitem = (todoname) => {
    const deletetodoitem = {
      type: "DELETE_ITEM",
      payload: {
        name: todoname,
      },
    };
    dispatchTodoItem(deletetodoitem);
  };

  return (
    <TodoItemsContext.Provider
      value={{ todoitems, addnewtodoitem, deletetodoitem }}
    >
      <center className={Styles.box}>
        <Appname></Appname>
        <div className="container text-center">
          <Mybtns></Mybtns>
          <Items></Items>
        </div>
      </center>
    </TodoItemsContext.Provider>
  );
}
export default App;
