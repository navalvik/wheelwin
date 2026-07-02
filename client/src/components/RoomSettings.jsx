import "../styles/roomSettings.css";

export default function RoomSettings({

    roomState,

    setRoomState

}){

    function update(field,value){

        setRoomState({

            ...roomState,

            [field]:value

        });

    }

    return(

        <div className="roomSettings">

            <div className="setting">

                <label>

                    Number of Players

                </label>

                <select

                    value={roomState.playersCount}

                    onChange={(e)=>

                        update(

                            "playersCount",

                            Number(e.target.value)

                        )

                    }

                >

                    <option value={2}>2</option>

                    <option value={3}>3</option>

                    <option value={4}>4</option>

                </select>

            </div>

            <div className="setting">

                <label>

                    Number of Wheel Sectors

                </label>

                <select

                    value={roomState.wheelSectors}

                    onChange={(e)=>

                        update(

                            "wheelSectors",

                            Number(e.target.value)

                        )

                    }

                >

                    <option value={8}>8</option>

                    <option value={12}>12</option>

                    <option value={16}>16</option>

                    <option value={24}>24</option>

                </select>

            </div>

            <div className="setting">

                <label>

                    Secret Room Code

                </label>

                <input

                    type="text"

                    maxLength={8}

                    value={roomState.roomCode}

                    onChange={(e)=>

                        update(

                            "roomCode",

                            e.target.value.toUpperCase()

                        )

                    }

                />

            </div>

        </div>

    );

}