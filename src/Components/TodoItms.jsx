import { useContext } from "react";
import styles from "./TodoItms.module.css";
import { MdDeleteForever } from "react-icons/md";
import TodoItemsContext from "../store/todo-context-api";

function Items() {
  const todoitemsObj = useContext(TodoItemsContext);
  return (
    <>
      <div className="row row-scal">
        {todoitemsObj.todoitems.map((myitem) => (
          <>
            <div className="col-sm-4">{myitem.name}</div>
            <div className="col-sm-4">{myitem.Duedate}</div>
            <div className="col-sm">
              <button
                type="button"
                className={`${styles.dangerbtns} btn btn-danger`}
                onClick={() => {
                  todoitemsObj.deletetodoitem(myitem.name);
                }}
              >
                <MdDeleteForever />
              </button>
            </div>
          </>
        ))}
      </div>
    </>
  );
}
export default Items;
