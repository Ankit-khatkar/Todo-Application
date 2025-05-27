import { useContext } from "react";
import TodoItemsContext from "../store/todo-context-api";
import styles from "./WelcomeMSG.module.css";

function WelcomeMSG() {
  const todoitemobj = useContext(TodoItemsContext);
  if (todoitemobj.todoitems.length === 0) {
    return (
      <>
        <div className={styles.WelcomeMSG}>Start Your Today !!</div>
      </>
    );
  }
}
export default WelcomeMSG;
