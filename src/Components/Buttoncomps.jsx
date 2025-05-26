import React, { useContext, useState } from "react";
import { MdAddTask } from "react-icons/md";
import TodoItemsContext from "../store/todo-context-api";
import Styles from "./Buttoncomps.module.css";

function Mybtns() {
  const todoitemsObj = useContext(TodoItemsContext);
  const [todoname, settodoname] = useState();
  const [tododate, settododate] = useState();
  const handletodonamechange = (event) => {
    settodoname(event.target.value);
  };
  const handletododatechange = (event) => {
    settododate(event.target.value);
  };
  const handleaddbutton = () => {
    if (todoname && tododate) {
      todoitemsObj.addnewtodoitem(todoname, tododate);
      settodoname("");
      settododate("");
    } else {
      alert("Please fill all the fields");
    }
  };

  return (
    <div>
      <div className="row row-scal">
        <div class="col-sm-4">
          <input
            className={Styles.inputfield}
            type="text"
            value={todoname}
            placeholder="Enter Todo Here..."
            onChange={handletodonamechange}
          />
        </div>
        <div className="col-sm-4">
          <input
            className={Styles.inputfield}
            type="date"
            value={tododate}
            onChange={handletododatechange}
          />
        </div>
        <div className="col-sm-4">
          <button
            type="button"
            className="btn btn-success"
            onClick={() => {
              handleaddbutton();
            }}
          >
            <MdAddTask />
          </button>
        </div>
      </div>
    </div>
  );
}
export default Mybtns;
