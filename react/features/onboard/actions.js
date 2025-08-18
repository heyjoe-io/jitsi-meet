import {
    SET_ONBOARD,
    SET_TALENT_INFO
} from './actionTypes';

// eslint-disable-next-line require-jsdoc
export function setOnboard(url) {
    return {
        type: SET_ONBOARD,
        url
    };
}

// eslint-disable-next-line require-jsdoc
export function setTalentInfo({ talent, studio, session }) {
    return {
        type: SET_TALENT_INFO,
        talent,
        studio,
        session
    };
}
