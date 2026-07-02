import GameLayout from "../layouts/GameLayout";

export default function Page6Result({ onNavigate }) {

    return (

        <GameLayout

            message="RESULT"

            nextEnabled={false}

            onNext={() => {}}

        >

            <div className="devPlaceholder">

                Page 6 — Result

            </div>

        </GameLayout>

    );

}
